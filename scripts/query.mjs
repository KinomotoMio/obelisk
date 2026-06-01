import { openDb, readLines, fs, path } from './db.mjs';

const ERROR_PATS = ['error','Error','ENOENT','failed','Failed','FAILED','permission denied','Permission denied','EPERM','EACCES','command not found','No such file','Exit code'];

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

function createQueryApi(db) {
  const q = (sql, ...p) => db.prepare(sql).all(...p);

  const search = (text, opts = {}) => {
    const { limit = 20, sessionId, project, after, before } = opts;
    let where = 'WHERE mf.text MATCH ?';
    const p = [text];
    if (sessionId) { where += ' AND mf.session_id=?'; p.push(sessionId); }
    if (project)   { where += ' AND s.project=?';     p.push(project); }
    if (after)     { where += ' AND m.timestamp>?';    p.push(after); }
    if (before)    { where += ' AND m.timestamp<?';    p.push(before); }
    p.push(limit);
    const rows = db.prepare(`
      SELECT m.uuid,m.session_id,m.text,m.role,m.timestamp,m.model,
             s.id as s_id,s.title as s_title,s.project as s_project,s.started_at as s_started
      FROM messages_fts mf JOIN messages m ON m.uuid=mf.uuid LEFT JOIN sessions s ON s.id=m.session_id
      ${where} ORDER BY rank LIMIT ?`).all(...p);
    return rows.map(r => {
      const ctx = db.prepare(
        'SELECT uuid,text,role,timestamp,model FROM messages WHERE session_id=? AND uuid!=? ORDER BY ABS(JULIANDAY(timestamp)-JULIANDAY(?)) LIMIT 6'
      ).all(r.session_id, r.uuid, r.timestamp).sort((a,b) => a.timestamp < b.timestamp ? -1 : 1);
      return {
        message: { uuid: r.uuid, text: r.text, role: r.role, timestamp: r.timestamp, model: r.model },
        session: { id: r.s_id, title: r.s_title, project: r.s_project, started_at: r.s_started },
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
    const agents = db.prepare('SELECT * FROM workflow_agents WHERE run_id=?').all(runId).map(a => ({
      ...a, messages: db.prepare('SELECT * FROM messages WHERE agent_id=? ORDER BY timestamp').all(a.agent_id),
    }));
    return { ...wf, agents };
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
    const likeClauses = ERROR_PATS.map(() => 'tr.content LIKE ?').join(' OR ');
    const likeParams = ERROR_PATS.map(p => `%${p}%`);
    const needsJoin = opts.project || opts.branch;
    const { where, params: filterParams } = buildWhere(opts, { sessionId: 'tr.session_id', project: 's.project', timestamp: 'rm.timestamp', branch: 's.git_branch' });
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=tr.session_id' : '';
    const allParams = [...likeParams, ...filterParams, limit];
    const rows = db.prepare(`SELECT tr.* FROM tool_results tr ${join} LEFT JOIN messages rm ON rm.uuid=tr.message_uuid WHERE (${likeClauses}) AND ${where} LIMIT ?`).all(...allParams);
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

  return { sql: q, search, context, trace, thread, subagents, workflows, workflowTree, fileHistory, failures, sessions, recent, summaries, raw };
}

export { createQueryApi };
