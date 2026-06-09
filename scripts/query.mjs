import { openDb, readLines, fs, path } from './db.mjs';

function normalizeOpts(optsOrScalar, scalarKey = 'sessionId') {
  if (optsOrScalar == null) return {};
  if (typeof optsOrScalar === 'string') return { [scalarKey]: optsOrScalar };
  if (typeof optsOrScalar === 'number') return { limit: optsOrScalar };
  return optsOrScalar;
}

function buildWhere(opts, aliases) {
  const clauses = [];
  const params = [];
  if (opts.sessionId) { clauses.push(`${aliases.sessionId} = ?`); params.push(opts.sessionId); }
  if (opts.sessions?.length) {
    clauses.push(`${aliases.sessionId} IN (${opts.sessions.map(() => '?').join(',')})`);
    params.push(...opts.sessions);
  }
  if (opts.project) { clauses.push(`${aliases.project} LIKE ?`); params.push(opts.project); }
  if (opts.after) { clauses.push(`${aliases.timestamp} > ?`); params.push(opts.after); }
  if (opts.before) { clauses.push(`${aliases.timestamp} < ?`); params.push(opts.before); }
  if (opts.branch) { clauses.push(`${aliases.branch} = ?`); params.push(opts.branch); }
  return { where: clauses.length ? clauses.join(' AND ') : '1=1', params };
}

const BASH_EXIT_PAT = 'Exit code %';

function assertReadOnlySql(sql) {
  const text = String(sql || '').trim();
  if (!/^(SELECT|WITH)\b/i.test(text)) {
    throw new Error('sql() only supports read-only SELECT/WITH queries');
  }
  if (/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM|ATTACH|DETACH)\b/i.test(text)) {
    throw new Error('sql() only supports read-only SELECT/WITH queries');
  }
}

const CJK_TEXT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function assertEnglishMemoryText(value, label) {
  const text = String(value || '');
  if (!text.trim()) return;
  if (CJK_TEXT_RE.test(text)) {
    const requirement = label.includes('query') ? 'must use English terms' : 'must be written in English';
    throw new Error(`${label} ${requirement}; translate user-language terms before using the memory layer`);
  }
}

function createQueryApi(db) {
  const q = (sql, ...p) => {
    assertReadOnlySql(sql);
    return db.prepare(sql).all(...p);
  };

  const normalizeOverviewOpts = (optsOrScalar) => {
    if (optsOrScalar == null) return {};
    if (typeof optsOrScalar === 'string') return { project: optsOrScalar };
    if (typeof optsOrScalar === 'number') return { limit: optsOrScalar };
    return optsOrScalar;
  };

  const search = (text, opts = {}) => {
    const { limit = 20, sessionId, project, after, before, cwd } = opts;
    let where = 'WHERE mf.text MATCH ?';
    const p = [text];
    if (sessionId) { where += ' AND mf.session_id=?'; p.push(sessionId); }
    if (project)   { where += ' AND s.project LIKE ?'; p.push(project); }
    if (after)     { where += ' AND m.timestamp>?';    p.push(after); }
    if (before)    { where += ' AND m.timestamp<?';    p.push(before); }
    if (cwd)       { where += ' AND m.cwd LIKE ?';     p.push(cwd); }
    p.push(limit);
    const rows = db.prepare(`
      SELECT m.uuid,m.session_id,m.text,m.role,m.timestamp,m.model,m.cwd,
             s.id as s_id,s.title as s_title,s.project as s_project,s.started_at as s_started,
             rank
      FROM messages_fts mf JOIN messages m ON m.uuid=mf.uuid LEFT JOIN sessions s ON s.id=m.session_id
      ${where} ORDER BY rank LIMIT ?`).all(...p);
    return rows.map(r => {
      const ctx = db.prepare(
        'SELECT uuid,text,role,timestamp,model FROM messages WHERE session_id=? AND uuid!=? ORDER BY ABS(JULIANDAY(timestamp)-JULIANDAY(?)) LIMIT 6'
      ).all(r.session_id, r.uuid, r.timestamp).sort((a,b) => a.timestamp < b.timestamp ? -1 : 1);
      return {
        message: { uuid: r.uuid, text: r.text, role: r.role, timestamp: r.timestamp, model: r.model, cwd: r.cwd },
        session: { id: r.s_id, title: r.s_title, project: r.s_project, started_at: r.s_started },
        rank: r.rank,
        context: ctx,
      };
    });
  };

  const context = (uuid) => {
    const msg = db.prepare('SELECT * FROM messages WHERE uuid=?').get(uuid);
    if (!msg) return null;
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(msg.session_id);
    const chain = [];
    let cur = msg;
    while (cur?.parent_uuid) { cur = db.prepare('SELECT * FROM messages WHERE uuid=?').get(cur.parent_uuid); if (cur) chain.unshift(cur); }
    let subagent = msg.agent_id ? db.prepare('SELECT * FROM subagents WHERE agent_id=?').get(msg.agent_id) : null;
    let workflow = null;
    if (msg.agent_id) {
      const wa = db.prepare('SELECT * FROM workflow_agents WHERE agent_id=?').get(msg.agent_id);
      if (wa) workflow = db.prepare('SELECT * FROM workflows WHERE run_id=?').get(wa.run_id);
    }
    return { message: msg, parentChain: chain, session, subagent, workflow };
  };

  const trace = (uuid) => {
    const chain = [];
    let cur = db.prepare('SELECT * FROM messages WHERE uuid=?').get(uuid);
    while (cur) { chain.unshift(cur); cur = cur.parent_uuid ? db.prepare('SELECT * FROM messages WHERE uuid=?').get(cur.parent_uuid) : null; }
    return chain;
  };

  const thread = (sid) => db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY timestamp').all(sid);

  const subagents = (optsOrSid) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 100 } = opts;
    const needsJoin = opts.project || opts.branch;
    const { where, params } = buildWhere(opts, { sessionId: 'sa.session_id', project: 's.project', timestamp: 'sa.session_id', branch: 's.git_branch' });
    params.push(limit);
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=sa.session_id' : '';
    return db.prepare(`SELECT sa.* FROM subagents sa ${join} WHERE ${where} LIMIT ?`).all(...params).map(r => {
      const c = db.prepare('SELECT COUNT(*) as c FROM messages WHERE agent_id=?').get(r.agent_id);
      return { ...r, messageCount: c?.c || 0 };
    });
  };

  const workflows = (optsOrSid) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 100 } = opts;
    const needsJoin = opts.project || opts.branch;
    const { where, params } = buildWhere(opts, { sessionId: 'w.session_id', project: 's.project', timestamp: 'w.timestamp', branch: 's.git_branch' });
    params.push(limit);
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=w.session_id' : '';
    return db.prepare(`SELECT w.* FROM workflows w ${join} WHERE ${where} ORDER BY w.timestamp DESC LIMIT ?`).all(...params);
  };

  const workflowTree = (runId) => {
    const wf = db.prepare('SELECT * FROM workflows WHERE run_id=?').get(runId);
    if (!wf) return null;
    let result = null;
    try { result = JSON.parse(wf.result_json); } catch {}
    const agents = db.prepare('SELECT * FROM workflow_agents WHERE run_id=?').all(runId).map(a => {
      const mc = db.prepare('SELECT COUNT(*) as c FROM messages WHERE agent_id=?').get(a.agent_id);
      return { ...a, messageCount: mc?.c || 0 };
    });
    return { ...wf, result, agents };
  };

  const fileHistory = (fp, opts = {}) => {
    const { limit = 200, after, before } = opts;
    let where = 'tc.file_path=?';
    const params = [fp];
    if (after)  { where += ' AND m.timestamp > ?'; params.push(after); }
    if (before) { where += ' AND m.timestamp < ?'; params.push(before); }
    params.push(limit);
    return db.prepare(
      `SELECT tc.*,s.title as s_title,s.project as s_project,m.timestamp as ts FROM tool_calls tc LEFT JOIN sessions s ON s.id=tc.session_id LEFT JOIN messages m ON m.uuid=tc.message_uuid WHERE ${where} ORDER BY m.timestamp LIMIT ?`
    ).all(...params).map(r => ({
      toolCall: { id: r.id, message_uuid: r.message_uuid, name: r.name, input_json: r.input_json },
      session: { id: r.session_id, title: r.s_title, project: r.s_project },
      timestamp: r.ts,
    }));
  };

  const failures = (optsOrSid) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 50 } = opts;
    const needsJoin = opts.project || opts.branch;
    const { where, params: filterParams } = buildWhere(opts, { sessionId: 'tr.session_id', project: 's.project', timestamp: 'rm.timestamp', branch: 's.git_branch' });
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=tr.session_id' : '';
    const errorCond = `(tr.is_error = 1 OR tr.content LIKE '${BASH_EXIT_PAT}')`;
    const allParams = [...filterParams, limit];
    const rows = db.prepare(`SELECT tr.* FROM tool_results tr ${join} LEFT JOIN messages rm ON rm.uuid=tr.message_uuid WHERE ${errorCond} AND ${where} ORDER BY rm.timestamp DESC LIMIT ?`).all(...allParams);
    return rows.map(r => {
      const tc = db.prepare('SELECT * FROM tool_calls WHERE id=?').get(r.tool_use_id);
      const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(r.session_id);
      const rm = db.prepare('SELECT * FROM messages WHERE uuid=?').get(r.message_uuid);
      const next = rm?.timestamp ? db.prepare('SELECT * FROM messages WHERE session_id=? AND timestamp>? ORDER BY timestamp LIMIT 3').all(r.session_id, rm.timestamp) : [];
      return { toolCall: tc, result: r, session, nextMessages: next };
    });
  };

  const sessions = (optsOrN) => {
    const opts = normalizeOpts(optsOrN, 'sessionId');
    const { limit = 50 } = opts;
    const { where, params } = buildWhere(opts, { sessionId: 's.id', project: 's.project', timestamp: 's.started_at', branch: 's.git_branch' });
    params.push(limit);
    return db.prepare(`SELECT * FROM sessions s WHERE ${where} ORDER BY ended_at DESC LIMIT ?`).all(...params);
  };

  const recent = (n = 10) => sessions({ limit: n });

  const summaries = (optsOrSid) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 100 } = opts;
    const { where, params } = buildWhere(opts, { sessionId: 'su.session_id', project: 's.project', timestamp: 'su.timestamp', branch: 's.git_branch' });
    params.push(limit);
    return db.prepare(`SELECT su.*, s.title as session_title, s.project FROM summaries su LEFT JOIN sessions s ON s.id=su.session_id WHERE ${where} ORDER BY su.timestamp DESC LIMIT ?`).all(...params);
  };

  const overview = (optsOrScalar) => {
    const opts = normalizeOverviewOpts(optsOrScalar);
    const cwd = process.cwd();
    const sessionLimit = opts.limit ?? 8;
    const projectLimit = opts.projectLimit ?? 20;
    const memoryLimit = opts.memoryLimit ?? 100;

    const projectDescriptor = (row, source, confidence) => row ? ({
      project: row.project,
      project_path: row.project_path || null,
      source,
      confidence,
    }) : null;

    const latestProjectByPattern = (pattern) => {
      const fromSessions = db.prepare(`
        SELECT project, project_path
        FROM sessions
        WHERE project LIKE ?
        ORDER BY COALESCE(ended_at, started_at) DESC
        LIMIT 1
      `).get(pattern);
      if (fromSessions) return fromSessions;
      return db.prepare(`
        SELECT project, NULL AS project_path
        FROM memories
        WHERE project LIKE ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(pattern);
    };

    const resolveCurrentProject = () => {
      if (opts.project) {
        const row = latestProjectByPattern(opts.project);
        const confidence = row ? (/[%_]/.test(opts.project) ? 'inferred' : 'exact') : 'unknown';
        return projectDescriptor(row || { project: opts.project, project_path: null }, 'opts', confidence);
      }

      const paths = db.prepare(`
        SELECT project, project_path, MAX(COALESCE(ended_at, started_at)) AS last_seen
        FROM sessions
        WHERE project IS NOT NULL AND project_path IS NOT NULL AND project_path != ''
        GROUP BY project, project_path
      `).all();
      const byProjectPath = paths
        .filter(r => cwd === r.project_path || cwd.startsWith(r.project_path + path.sep))
        .sort((a, b) => b.project_path.length - a.project_path.length || String(b.last_seen || '').localeCompare(String(a.last_seen || '')))[0];
      if (byProjectPath) return projectDescriptor(byProjectPath, 'cwd_project_path', 'exact');

      const byMessageCwd = db.prepare(`
        SELECT s.project, s.project_path, MAX(m.timestamp) AS last_seen
        FROM messages m
        LEFT JOIN sessions s ON s.id=m.session_id
        WHERE m.cwd = ? AND s.project IS NOT NULL
        GROUP BY s.project, s.project_path
        ORDER BY last_seen DESC
        LIMIT 1
      `).get(cwd);
      if (byMessageCwd) return projectDescriptor(byMessageCwd, 'cwd_messages', 'inferred');

      return null;
    };

    const projects = db.prepare(`
      WITH names AS (
        SELECT project FROM sessions WHERE project IS NOT NULL GROUP BY project
        UNION
        SELECT project FROM memories WHERE project IS NOT NULL GROUP BY project
      ),
      session_stats AS (
        SELECT project, COUNT(*) AS session_count, MAX(COALESCE(ended_at, started_at)) AS last_session_at
        FROM sessions
        WHERE project IS NOT NULL
        GROUP BY project
      ),
      memory_stats AS (
        SELECT project, COUNT(*) AS memory_count, MAX(created_at) AS last_memory_at
        FROM memories
        WHERE project IS NOT NULL
        GROUP BY project
      )
      SELECT
        n.project,
        (
          SELECT s2.project_path
          FROM sessions s2
          WHERE s2.project = n.project AND s2.project_path IS NOT NULL
          ORDER BY COALESCE(s2.ended_at, s2.started_at) DESC
          LIMIT 1
        ) AS project_path,
        COALESCE(ss.session_count, 0) AS session_count,
        COALESCE(ms.memory_count, 0) AS memory_count,
        ss.last_session_at,
        ms.last_memory_at
      FROM names n
      LEFT JOIN session_stats ss ON ss.project = n.project
      LEFT JOIN memory_stats ms ON ms.project = n.project
      ORDER BY COALESCE(ss.last_session_at, ms.last_memory_at) DESC
      LIMIT ?
    `).all(projectLimit).map(row => {
      const branches = db.prepare(`
        SELECT git_branch
        FROM sessions
        WHERE project = ? AND git_branch IS NOT NULL AND git_branch != ''
        GROUP BY git_branch
        ORDER BY MAX(COALESCE(ended_at, started_at)) DESC
        LIMIT 5
      `).all(row.project).map(r => r.git_branch);
      return { ...row, recent_branches: branches };
    });

    const currentProject = resolveCurrentProject();
    let current_project = null;
    if (currentProject?.project) {
      const sessionTotal = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE project = ?').get(currentProject.project)?.c || 0;
      const sessionsForProject = db.prepare(`
        SELECT id, title, project, project_path, started_at, ended_at, git_branch, message_count
        FROM sessions
        WHERE project = ?
        ORDER BY COALESCE(ended_at, started_at) DESC
        LIMIT ?
      `).all(currentProject.project, sessionLimit);
      const memoryTotal = db.prepare('SELECT COUNT(*) AS c FROM memories WHERE project = ?').get(currentProject.project)?.c || 0;
      const memoriesForProject = db.prepare(`
        SELECT id, path, summary, session_id, project, created_at
        FROM memories
        WHERE project = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(currentProject.project, memoryLimit);
      current_project = {
        project: currentProject.project,
        project_path: currentProject.project_path,
        session_total: sessionTotal,
        sessions: sessionsForProject,
        memory_total: memoryTotal,
        memories: memoriesForProject,
      };
    }

    const totalProjects = db.prepare(`
      SELECT COUNT(*) AS c
      FROM (
        SELECT project FROM sessions WHERE project IS NOT NULL GROUP BY project
        UNION
        SELECT project FROM memories WHERE project IS NOT NULL GROUP BY project
      )
    `).get()?.c || 0;
    const totalSessions = db.prepare('SELECT COUNT(*) AS c FROM sessions').get()?.c || 0;
    const totalMemories = db.prepare('SELECT COUNT(*) AS c FROM memories').get()?.c || 0;

    return {
      current: {
        cwd,
        project: currentProject,
      },
      current_project,
      projects,
      totals: {
        projects: totalProjects,
        sessions: totalSessions,
        memories: totalMemories,
      },
    };
  };

  const resolveJsonlPath = (messageUuid) => {
    const msg = db.prepare('SELECT session_id, agent_id FROM messages WHERE uuid=?').get(messageUuid);
    if (!msg) return null;
    if (msg.agent_id) {
      const wa = db.prepare('SELECT agent_id, run_id, session_id FROM workflow_agents WHERE agent_id=?').get(msg.agent_id);
      if (wa) {
        const ses = db.prepare('SELECT jsonl_path FROM sessions WHERE id=?').get(wa.session_id);
        if (ses) return path.join(path.dirname(ses.jsonl_path), wa.session_id, 'subagents', 'workflows', wa.run_id, wa.agent_id + '.jsonl');
      }
      const sa = db.prepare('SELECT agent_id, session_id FROM subagents WHERE agent_id=?').get(msg.agent_id);
      if (sa) {
        const ses = db.prepare('SELECT jsonl_path FROM sessions WHERE id=?').get(sa.session_id);
        if (ses) return path.join(path.dirname(ses.jsonl_path), sa.session_id, 'subagents', sa.agent_id + '.jsonl');
      }
    } else {
      const ses = db.prepare('SELECT jsonl_path FROM sessions WHERE id=?').get(msg.session_id);
      if (ses) return ses.jsonl_path;
    }
    return null;
  };

  const findRawLine = (jsonlPath, uuid) => {
    if (!jsonlPath || !fs.existsSync(jsonlPath)) return null;
    let found = null;
    readLines(jsonlPath, (line) => {
      if (!line.includes(uuid)) return;
      try { const obj = JSON.parse(line); if (obj.uuid === uuid) { found = line; return false; } } catch {}
    });
    return found;
  };

  const raw = (messageUuid, opts = {}) => {
    const { offset = 0, limit = 10000 } = opts;
    const jsonlPath = resolveJsonlPath(messageUuid);
    const line = findRawLine(jsonlPath, messageUuid);
    if (!line) return null;
    return {
      text: line.slice(offset, offset + limit),
      totalLength: line.length,
      offset,
      limit,
      hasMore: offset + limit < line.length,
    };
  };

  const memories = (optsOrSid) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 50, query } = opts;
    assertEnglishMemoryText(query, 'memories() query');
    const needsJoin = opts.branch;
    const { where: baseWhere, params } = buildWhere(opts, {
      sessionId: 'mem.session_id',
      project: 'mem.project',
      timestamp: 'mem.created_at',
      branch: 's.git_branch',
    });
    const terms = String(query || '')
      .trim()
      .replace(/[-_]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    let where = baseWhere;
    for (const term of terms) {
      where += " AND lower(coalesce(mem.summary,'') || ' ' || coalesce(mem.path,'')) LIKE ?";
      params.push(`%${term.toLowerCase()}%`);
    }
    params.push(limit);
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=mem.session_id' : '';
    return db.prepare(`SELECT mem.* FROM memories mem ${join} WHERE ${where} ORDER BY mem.created_at DESC LIMIT ?`).all(...params);
  };

  return { sql: q, search, context, trace, thread, subagents, workflows, workflowTree, fileHistory, failures, sessions, recent, summaries, raw, memories, overview };
}

function createRememberApi(db) {
  const resolveMemoryPath = (memoryPath, sessionId) => {
    let base = null;
    if (sessionId) {
      base = db.prepare('SELECT project_path FROM sessions WHERE id=?').get(sessionId)?.project_path || null;
    }
    const resolved = path.isAbsolute(memoryPath)
      ? path.normalize(memoryPath)
      : path.resolve(base || process.cwd(), memoryPath);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`remember() memory file does not exist: ${resolved}`);
    }
    if (!stat.isFile()) throw new Error(`remember() memory path is not a file: ${resolved}`);
    return resolved;
  };

  const remember = ({ path: memoryPath, session_id, message_start, message_end, summary, project }) => {
    if (!memoryPath || !summary) throw new Error('remember() requires path and summary');
    assertEnglishMemoryText(summary, 'remember() summary');
    const normalizedPath = resolveMemoryPath(memoryPath, session_id);
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const proj = project || db.prepare('SELECT project FROM sessions WHERE id=?').get(session_id)?.project || null;
    const created_at = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO memories (id, session_id, project, message_start, message_end, path, summary, created_at) VALUES (?,?,?,?,?,?,?,?)').run(
      id, session_id || null, proj, message_start || null, message_end || null, normalizedPath, summary, created_at);
    return { id, path: normalizedPath, project: proj, created_at };
  };

  return { remember };
}

export { createQueryApi, createRememberApi };
