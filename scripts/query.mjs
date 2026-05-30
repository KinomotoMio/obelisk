import { openDb, readLines, fs, path } from './db.mjs';

const ERROR_PATS = ['error','Error','ENOENT','failed','Failed','FAILED','permission denied','Permission denied','EPERM','EACCES','command not found','No such file','Exit code'];

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

  const subagents = (sid) => {
    return db.prepare('SELECT * FROM subagents WHERE session_id=?').all(sid).map(r => {
      const c = db.prepare('SELECT COUNT(*) as c FROM messages WHERE agent_id=?').get(r.agent_id);
      return { ...r, messageCount: c?.c || 0 };
    });
  };

  const workflows = (sid) => sid
    ? db.prepare('SELECT * FROM workflows WHERE session_id=? ORDER BY timestamp').all(sid)
    : db.prepare('SELECT * FROM workflows ORDER BY timestamp DESC').all();

  const workflowTree = (runId) => {
    const wf = db.prepare('SELECT * FROM workflows WHERE run_id=?').get(runId);
    if (!wf) return null;
    const agents = db.prepare('SELECT * FROM workflow_agents WHERE run_id=?').all(runId).map(a => ({
      ...a, messages: db.prepare('SELECT * FROM messages WHERE agent_id=? ORDER BY timestamp').all(a.agent_id),
    }));
    return { ...wf, agents };
  };

  const fileHistory = (fp) => {
    return db.prepare(
      'SELECT tc.*,s.title as s_title,s.project as s_project FROM tool_calls tc LEFT JOIN sessions s ON s.id=tc.session_id WHERE tc.file_path=? ORDER BY tc.id'
    ).all(fp).map(r => ({
      toolCall: { id: r.id, message_uuid: r.message_uuid, name: r.name, input_json: r.input_json },
      session: { id: r.session_id, title: r.s_title, project: r.s_project },
      timestamp: db.prepare('SELECT timestamp FROM messages WHERE uuid=?').get(r.message_uuid)?.timestamp,
    }));
  };

  const failures = (sid) => {
    const likeClauses = ERROR_PATS.map(() => 'content LIKE ?').join(' OR ');
    const likeParams = ERROR_PATS.map(p => `%${p}%`);
    let query = `SELECT * FROM tool_results WHERE (${likeClauses})`;
    const params = [...likeParams];
    if (sid) { query += ' AND session_id=?'; params.push(sid); }
    const rows = db.prepare(query).all(...params);
    return rows.map(r => {
      const tc = db.prepare('SELECT * FROM tool_calls WHERE id=?').get(r.tool_use_id);
      const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(r.session_id);
      const rm = db.prepare('SELECT * FROM messages WHERE uuid=?').get(r.message_uuid);
      const next = rm?.timestamp ? db.prepare('SELECT * FROM messages WHERE session_id=? AND timestamp>? ORDER BY timestamp LIMIT 3').all(r.session_id, rm.timestamp) : [];
      return { toolCall: tc, result: r, session, nextMessages: next };
    });
  };

  const recent = (n = 10) => db.prepare('SELECT * FROM sessions ORDER BY ended_at DESC LIMIT ?').all(n);

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

  return { sql: q, search, context, trace, thread, subagents, workflows, workflowTree, fileHistory, failures, recent, raw };
}

export { createQueryApi };
