#!/usr/bin/env node
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HISTORY_PATH = path.join(CLAUDE_DIR, 'history.jsonl');
const DB_PATH = path.join(CLAUDE_DIR, 'obelisk.sqlite');
const TEXT_LIMIT = 10000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, title TEXT, project TEXT, project_path TEXT,
  started_at TEXT, ended_at TEXT, git_branch TEXT, version TEXT,
  message_count INTEGER DEFAULT 0, jsonl_path TEXT);
CREATE TABLE IF NOT EXISTS messages (
  uuid TEXT PRIMARY KEY, session_id TEXT, type TEXT, parent_uuid TEXT,
  timestamp TEXT, role TEXT, text TEXT, model TEXT,
  is_sidechain INTEGER DEFAULT 0, agent_id TEXT,
  input_tokens INTEGER, output_tokens INTEGER);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY, message_uuid TEXT, session_id TEXT,
  name TEXT, input_json TEXT, file_path TEXT);
CREATE TABLE IF NOT EXISTS tool_results (
  tool_use_id TEXT PRIMARY KEY, message_uuid TEXT, session_id TEXT,
  content TEXT, file_path TEXT);
CREATE TABLE IF NOT EXISTS subagents (
  agent_id TEXT PRIMARY KEY, session_id TEXT, parent_tool_use_id TEXT,
  agent_type TEXT, description TEXT, duration_ms INTEGER, total_tokens INTEGER);
CREATE TABLE IF NOT EXISTS workflows (
  run_id TEXT PRIMARY KEY, session_id TEXT, task_id TEXT,
  script TEXT, result_json TEXT, timestamp TEXT, agent_count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS workflow_agents (
  agent_id TEXT PRIMARY KEY, run_id TEXT, session_id TEXT,
  agent_type TEXT, description TEXT);
CREATE TABLE IF NOT EXISTS index_state (
  jsonl_path TEXT PRIMARY KEY, mtime REAL, lines_processed INTEGER);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  uuid UNINDEXED, session_id UNINDEXED, text, content=messages, content_rowid=rowid);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_tc_session_name ON tool_calls(session_id, name);
CREATE INDEX IF NOT EXISTS idx_tc_file ON tool_calls(file_path);
CREATE INDEX IF NOT EXISTS idx_sa_session ON subagents(session_id);
CREATE INDEX IF NOT EXISTS idx_wf_session ON workflows(session_id);
CREATE INDEX IF NOT EXISTS idx_wa_run ON workflow_agents(run_id);
`;

function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec(SCHEMA);
  return db;
}

function trunc(s) {
  return typeof s === 'string' && s.length > TEXT_LIMIT ? s.slice(0, TEXT_LIMIT) : s;
}

function truncJson(obj, limit = TEXT_LIMIT) {
  if (obj === null || obj === undefined) return null;
  const walk = (v) => {
    if (typeof v === 'string') return v.length > limit ? v.slice(0, limit) + '...[truncated]' : v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(obj));
}

function extractText(content) {
  if (typeof content === 'string') return trunc(content);
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const b of content) {
    if (b.type === 'text' && b.text) parts.push(b.text);
    else if (b.type === 'thinking' && b.thinking) parts.push(b.thinking);
  }
  return parts.length ? trunc(parts.join('\n')) : null;
}

function filePath(name, input) {
  if (!input) return null;
  return ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name) ? (input.file_path || null) : null;
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function discoverJsonlFiles() {
  const files = [];
  if (!fs.existsSync(PROJECTS_DIR)) return files;
  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    const projPath = path.join(PROJECTS_DIR, proj);
    if (!isDir(projPath)) continue;
    for (const f of fs.readdirSync(projPath)) {
      if (f.endsWith('.jsonl'))
        files.push({ path: path.join(projPath, f), sessionId: f.slice(0, -6), project: proj, isSubagent: false });
    }
    for (const sd of fs.readdirSync(projPath)) {
      const saDir = path.join(projPath, sd, 'subagents');
      if (!isDir(saDir)) continue;
      for (const sf of fs.readdirSync(saDir)) {
        if (sf.endsWith('.jsonl'))
          files.push({ path: path.join(saDir, sf), sessionId: sd, project: proj, isSubagent: true, agentId: sf.slice(0, -6) });
      }
      const wfRoot = path.join(saDir, 'workflows');
      if (!isDir(wfRoot)) continue;
      for (const wfDir of fs.readdirSync(wfRoot)) {
        const wfPath = path.join(wfRoot, wfDir);
        if (!isDir(wfPath)) continue;
        for (const wf of fs.readdirSync(wfPath)) {
          if (wf.endsWith('.jsonl'))
            files.push({ path: path.join(wfPath, wf), sessionId: sd, project: proj, isSubagent: true, agentId: wf.slice(0, -6), workflowRunId: wfDir });
        }
      }
    }
  }
  return files;
}

function needsReindex(db, fp) {
  const mt = fs.statSync(fp).mtimeMs;
  const row = db.prepare('SELECT mtime, lines_processed FROM index_state WHERE jsonl_path = ?').get(fp);
  if (!row) return { needed: true, skip: 0 };
  return mt > row.mtime ? { needed: true, skip: row.lines_processed } : { needed: false, skip: 0 };
}

function indexJsonl(db, fi) {
  const { needed, skip } = needsReindex(db, fi.path);
  if (!needed) return;
  const lines = fs.readFileSync(fi.path, 'utf8').split('\n').filter(Boolean);
  const mt = fs.statSync(fi.path).mtimeMs;

  const ins = {
    ses: db.prepare('INSERT OR REPLACE INTO sessions (id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path) VALUES (?,?,?,?,?,?,?,?,?,?)'),
    msg: db.prepare('INSERT OR REPLACE INTO messages (uuid,session_id,type,parent_uuid,timestamp,role,text,model,is_sidechain,agent_id,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),
    tc:  db.prepare('INSERT OR REPLACE INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path) VALUES (?,?,?,?,?,?)'),
    tr:  db.prepare('INSERT OR REPLACE INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path) VALUES (?,?,?,?,?)'),
    idx: db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,?,?)'),
  };

  const existing = !fi.isSubagent ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(fi.sessionId) : null;
  const sm = {
    started_at: existing?.started_at || null,
    ended_at: existing?.ended_at || null,
    git_branch: existing?.git_branch || null,
    version: existing?.version || null,
    title: existing?.title || null,
    n: existing?.message_count || 0,
  };

  for (let i = skip; i < lines.length; i++) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    const sid = fi.sessionId;
    const ts = obj.timestamp || null;

    if (obj.type === 'ai-title' && obj.aiTitle) { sm.title = obj.aiTitle; continue; }
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;

    if (ts && (!sm.started_at || ts < sm.started_at)) sm.started_at = ts;
    if (ts && (!sm.ended_at || ts > sm.ended_at)) sm.ended_at = ts;
    if (obj.gitBranch) sm.git_branch = obj.gitBranch;
    if (obj.version) sm.version = obj.version;
    sm.n++;

    const msg = obj.message || {};
    const text = extractText(msg.content);
    const usage = msg.usage || {};
    const aid = fi.isSubagent ? fi.agentId : (obj.agentId || null);

    if (obj.uuid) {
      ins.msg.run(obj.uuid, sid, obj.type, obj.parentUuid || null, ts,
        msg.role || obj.type, text, msg.model || null,
        obj.isSidechain ? 1 : 0, aid, usage.input_tokens || null, usage.output_tokens || null);
    }

    if (obj.type === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use' && b.id)
          ins.tc.run(b.id, obj.uuid, sid, b.name, truncJson(b.input || {}), filePath(b.name, b.input));
      }
    }

    if (obj.type === 'user' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const rt = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map(c => c.text || '').join('\n') : '';
        ins.tr.run(b.tool_use_id, obj.uuid, sid, trunc(rt), obj.toolUseResult?.filePath || null);
      }
    }
  }

  if (!fi.isSubagent) {
    const pp = '/' + fi.project.replace(/-/g, '/').replace(/^\//, '');
    ins.ses.run(fi.sessionId, sm.title, fi.project, pp, sm.started_at, sm.ended_at, sm.git_branch, sm.version, sm.n, fi.path);
  }
  ins.idx.run(fi.path, mt, lines.length);
}

function indexSubagentMeta(db, fi) {
  if (!fi.isSubagent) return;
  const mp = fi.path.replace('.jsonl', '.meta.json');
  if (!fs.existsSync(mp)) return;
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const tok = db.prepare('SELECT COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) as t FROM messages WHERE agent_id=?').get(fi.agentId);
    const ts = db.prepare('SELECT MIN(timestamp) as t0, MAX(timestamp) as t1 FROM messages WHERE agent_id=?').get(fi.agentId);
    const dur = ts?.t0 && ts?.t1 ? new Date(ts.t1).getTime() - new Date(ts.t0).getTime() : null;
    if (fi.workflowRunId) {
      db.prepare('INSERT OR REPLACE INTO workflow_agents VALUES(?,?,?,?,?)').run(fi.agentId, fi.workflowRunId, fi.sessionId, meta.agentType||null, meta.description||null);
    } else {
      db.prepare('INSERT OR REPLACE INTO subagents VALUES(?,?,?,?,?,?,?)').run(fi.agentId, fi.sessionId, meta.toolUseId||null, meta.agentType||null, meta.description||null, dur, tok?.t||0);
    }
  } catch {}
}

function indexWorkflows(db) {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    const pp = path.join(PROJECTS_DIR, proj);
    if (!isDir(pp)) continue;
    for (const sd of fs.readdirSync(pp)) {
      const wd = path.join(pp, sd, 'workflows');
      if (!isDir(wd)) continue;
      for (const f of fs.readdirSync(wd)) {
        if (!f.endsWith('.json')) continue;
        try {
          const wf = JSON.parse(fs.readFileSync(path.join(wd, f), 'utf8'));
          if (!wf.runId) continue;
          const ac = db.prepare('SELECT COUNT(*) as c FROM workflow_agents WHERE run_id=?').get(wf.runId);
          db.prepare('INSERT OR REPLACE INTO workflows VALUES(?,?,?,?,?,?,?)').run(
            wf.runId, sd, wf.taskId||null, wf.script||null,
            wf.result ? JSON.stringify(wf.result) : null, wf.timestamp||null, ac?.c||0);
        } catch {}
      }
    }
  }
}

function indexHistory(db) {
  if (!fs.existsSync(HISTORY_PATH)) return;
  for (const line of fs.readFileSync(HISTORY_PATH, 'utf8').split('\n').filter(Boolean)) {
    try {
      const o = JSON.parse(line);
      if (o.sessionId && o.title) db.prepare('UPDATE sessions SET title=? WHERE id=? AND title IS NULL').run(o.title, o.sessionId);
    } catch {}
  }
}

function buildIndex() {
  const db = openDb();
  const files = discoverJsonlFiles();
  db.exec('BEGIN');
  try {
    for (const f of files) { indexJsonl(db, f); indexSubagentMeta(db, f); }
    indexWorkflows(db);
    indexHistory(db);
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  db.close();
}

// --- Query API ---

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
    const rows = sid
      ? db.prepare('SELECT * FROM tool_results WHERE session_id=?').all(sid)
      : db.prepare('SELECT * FROM tool_results').all();
    const out = [];
    for (const r of rows) {
      if (!r.content || !ERROR_PATS.some(p => r.content.includes(p))) continue;
      const tc = db.prepare('SELECT * FROM tool_calls WHERE id=?').get(r.tool_use_id);
      const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(r.session_id);
      const rm = db.prepare('SELECT * FROM messages WHERE uuid=?').get(r.message_uuid);
      const next = rm?.timestamp ? db.prepare('SELECT * FROM messages WHERE session_id=? AND timestamp>? ORDER BY timestamp LIMIT 3').all(r.session_id, rm.timestamp) : [];
      out.push({ toolCall: tc, result: r, session, nextMessages: next });
    }
    return out;
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
    for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
      if (!line || !line.includes(uuid)) continue;
      try { const obj = JSON.parse(line); if (obj.uuid === uuid) return line; } catch {}
    }
    return null;
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

// --- Script executor ---

function executeQuery(db, scriptContent) {
  const api = createQueryApi(db);
  const sandbox = {
    ...api, JSON, Math, Array, Object, Set, Map, Date, RegExp,
    parseInt, parseFloat, String, Number, Boolean, Error, Promise, console, setTimeout,
  };
  const ctx = vm.createContext(sandbox);
  return vm.runInNewContext(`(async()=>{${scriptContent}})()`, ctx, { timeout: 30000 });
}

// --- CLI ---

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--build') {
    buildIndex();
    process.stdout.write(JSON.stringify({ ok: true, db: DB_PATH }) + '\n');
    return;
  }
  if (args[0] === '--search' && args[1]) {
    buildIndex();
    const db = openDb();
    process.stdout.write(JSON.stringify(createQueryApi(db).search(args.slice(1).join(' ')), null, 2) + '\n');
    db.close();
    return;
  }
  if (args[0] === '--query' && args[1]) {
    buildIndex();
    const db = openDb();
    const script = fs.readFileSync(path.resolve(args[1]), 'utf8');
    executeQuery(db, script)
      .then(r => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); db.close(); })
      .catch(e => { process.stdout.write(JSON.stringify({ error: e.message, stack: e.stack }) + '\n'); db.close(); process.exitCode = 1; });
    return;
  }
  process.stderr.write('Usage:\n  node runtime.mjs --build\n  node runtime.mjs --search "text"\n  node runtime.mjs --query <file.js>\n');
  process.exitCode = 1;
}

main();
