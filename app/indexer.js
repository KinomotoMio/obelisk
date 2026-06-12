const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const TEXT_LIMIT = 10000;
const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DEFAULT_DB_PATH = path.join(DEFAULT_CLAUDE_DIR, 'obelisk.sqlite');
const DEFAULT_PROJECTS_DIR = path.join(DEFAULT_CLAUDE_DIR, 'projects');
const DEFAULT_HISTORY_PATH = path.join(DEFAULT_CLAUDE_DIR, 'history.jsonl');

function resolveSchemaPath() {
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', 'scripts', 'schema.sql'),
    process.resourcesPath ? path.join(process.resourcesPath, 'scripts', 'schema.sql') : null,
  ].filter(Boolean);
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error('Obelisk schema.sql not found');
  return found;
}

function openIndexDb({ dbPath = DEFAULT_DB_PATH, schemaPath = resolveSchemaPath(), DatabaseImpl = Database } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseImpl(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrateDb(db);
  return db;
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateDb(db) {
  ensureColumn(db, 'messages', 'content_type', 'TEXT');
  ensureColumn(db, 'messages', 'is_meta', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'memories', 'anchors', 'TEXT');
  ensureColumn(db, 'memories', 'deleted_at', 'TEXT');
  ensureColumn(db, 'memories', 'deleted_reason', 'TEXT');
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

function extractContentType(content) {
  if (typeof content === 'string') return 'text';
  if (!Array.isArray(content) || !content.length) return 'unknown';
  const types = new Set();
  let sawUnknown = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') { sawUnknown = true; continue; }
    if (b.type === 'text') types.add('text');
    else if (b.type === 'thinking') types.add('thinking');
    else if (b.type === 'tool_use') types.add('tool_use');
    else if (b.type === 'tool_result') types.add('tool_result');
    else sawUnknown = true;
  }
  return !sawUnknown && types.size === 1 ? [...types][0] : 'unknown';
}

const COMMAND_ENVELOPE_RE = /^\s*(<command-name>[^<]+<\/command-name>|<task-notification>|<local-command-caveat>|<local-command-stdout>)/;

function extractMessageIsMeta(record, text = extractText(record?.message?.content)) {
  const msg = record?.message || {};
  if (record?.isMeta === true || msg.isMeta === true) return 1;
  return typeof text === 'string' && COMMAND_ENVELOPE_RE.test(text) ? 1 : 0;
}

function filePath(name, input) {
  if (!input) return null;
  return ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name) ? (input.file_path || null) : null;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readLines(filePath, callback) {
  const data = fs.readFileSync(filePath, 'utf8');
  const lines = data.split('\n');
  for (const line of lines) {
    if (line && callback(line) === false) return;
  }
}

function legacyProjectPathFromSlug(project) {
  if (!project) return null;
  return '/' + project.replace(/-/g, '/').replace(/^\//, '');
}

function normalizeObservedCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim() || !path.isAbsolute(cwd)) return null;
  return path.normalize(cwd);
}

function inferProjectPath(project, observedCwds = []) {
  const byPath = new Map();
  for (const cwd of observedCwds) {
    const normalized = normalizeObservedCwd(cwd);
    if (!normalized) continue;
    const current = byPath.get(normalized) || { path: normalized, count: 0, first: byPath.size };
    current.count++;
    byPath.set(normalized, current);
  }
  const best = [...byPath.values()].sort((a, b) => b.count - a.count || a.first - b.first)[0];
  return best?.path || legacyProjectPathFromSlug(project);
}

function discoverJsonlFiles({ projectsDir = DEFAULT_PROJECTS_DIR } = {}) {
  const files = [];
  if (!fs.existsSync(projectsDir)) return files;
  let projects;
  try { projects = fs.readdirSync(projectsDir); } catch { return files; }
  for (const proj of projects) {
    const projPath = path.join(projectsDir, proj);
    if (!isDir(projPath)) continue;
    let entries;
    try { entries = fs.readdirSync(projPath); } catch { continue; }
    for (const f of entries) {
      if (f.endsWith('.jsonl'))
        files.push({ path: path.join(projPath, f), sessionId: f.slice(0, -6), project: proj, isSubagent: false });
    }
    for (const sd of entries) {
      const saDir = path.join(projPath, sd, 'subagents');
      if (!isDir(saDir)) continue;
      let saEntries;
      try { saEntries = fs.readdirSync(saDir); } catch { continue; }
      for (const sf of saEntries) {
        if (sf.endsWith('.jsonl'))
          files.push({ path: path.join(saDir, sf), sessionId: sd, project: proj, isSubagent: true, agentId: sf.slice(0, -6) });
      }
      const wfRoot = path.join(saDir, 'workflows');
      if (!isDir(wfRoot)) continue;
      let wfDirs;
      try { wfDirs = fs.readdirSync(wfRoot); } catch { continue; }
      for (const wfDir of wfDirs) {
        const wfPath = path.join(wfRoot, wfDir);
        if (!isDir(wfPath)) continue;
        let wfEntries;
        try { wfEntries = fs.readdirSync(wfPath); } catch { continue; }
        for (const wf of wfEntries) {
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
  if (!row) return { needed: true, skip: 0, mtime: mt };
  return mt > row.mtime ? { needed: true, skip: row.lines_processed, mtime: mt } : { needed: false, skip: 0, mtime: mt };
}

function indexJsonl(db, fi) {
  const { needed, skip, mtime } = needsReindex(db, fi.path);
  if (!needed) return;
  const ins = {
    ses: db.prepare('INSERT OR REPLACE INTO sessions (id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path) VALUES (?,?,?,?,?,?,?,?,?,?)'),
    msg: db.prepare('INSERT OR REPLACE INTO messages (uuid,session_id,type,parent_uuid,timestamp,role,text,content_type,is_meta,model,is_sidechain,agent_id,input_tokens,output_tokens,cwd,skill) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    tc:  db.prepare('INSERT OR REPLACE INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path) VALUES (?,?,?,?,?,?)'),
    tr:  db.prepare('INSERT OR REPLACE INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path,is_error) VALUES (?,?,?,?,?,?)'),
    sum: db.prepare('INSERT OR REPLACE INTO summaries (id,session_id,timestamp,source,content) VALUES (?,?,?,?,?)'),
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
    cwds: [],
  };

  let lineNum = 0;
  readLines(fi.path, (line) => {
    lineNum++;
    if (lineNum <= skip) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    const sid = fi.sessionId;
    const ts = obj.timestamp || null;
    if (obj.type === 'ai-title' && obj.aiTitle) { sm.title = obj.aiTitle; return; }
    if (obj.type === 'system' && obj.subtype === 'away_summary' && obj.content) {
      ins.sum.run(obj.uuid || `${sid}-away-${ts}`, sid, ts, 'away_summary', obj.content);
      return;
    }
    if (obj.type === 'system' && obj.subtype === 'turn_duration' && obj.parentUuid && obj.durationMs) {
      db.prepare('UPDATE messages SET turn_duration_ms=? WHERE uuid=?').run(obj.durationMs, obj.parentUuid);
      return;
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') return;
    if (ts && (!sm.started_at || ts < sm.started_at)) sm.started_at = ts;
    if (ts && (!sm.ended_at || ts > sm.ended_at)) sm.ended_at = ts;
    if (obj.gitBranch) sm.git_branch = obj.gitBranch;
    if (obj.version) sm.version = obj.version;
    sm.n++;
    if (!fi.isSubagent && obj.cwd) sm.cwds.push(obj.cwd);

    const msg = obj.message || {};
    const text = extractText(msg.content);
    const contentType = extractContentType(msg.content);
    const isMeta = extractMessageIsMeta(obj, text);
    const usage = msg.usage || {};
    const aid = fi.isSubagent ? fi.agentId : (obj.agentId || null);
    if (obj.uuid) {
      ins.msg.run(obj.uuid, sid, obj.type, obj.parentUuid || null, ts,
        msg.role || obj.type, text, contentType, isMeta, msg.model || null,
        obj.isSidechain ? 1 : 0, aid, usage.input_tokens || null, usage.output_tokens || null,
        obj.cwd || null, obj.attributionSkill || null);
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
        ins.tr.run(b.tool_use_id, obj.uuid, sid, trunc(rt), obj.toolUseResult?.filePath || null, b.is_error ? 1 : 0);
      }
    }
  });

  if (!fi.isSubagent) {
    const pp = inferProjectPath(fi.project, sm.cwds);
    ins.ses.run(fi.sessionId, sm.title, fi.project, pp, sm.started_at, sm.ended_at, sm.git_branch, sm.version, sm.n, fi.path);
  }
  ins.idx.run(fi.path, mtime, lineNum);
}

function refreshSessionProjectPaths(db) {
  const sessions = db.prepare('SELECT id, project FROM sessions').all();
  const cwdStmt = db.prepare(`
    SELECT cwd FROM messages
    WHERE session_id = ? AND cwd IS NOT NULL AND cwd != ''
    ORDER BY timestamp IS NULL, timestamp
  `);
  const update = db.prepare('UPDATE sessions SET project_path = ? WHERE id = ?');
  for (const session of sessions) {
    const cwds = cwdStmt.all(session.id).map(row => row.cwd);
    const projectPath = inferProjectPath(session.project, cwds);
    if (projectPath) update.run(projectPath, session.id);
  }
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
      db.prepare('INSERT OR REPLACE INTO workflow_agents (agent_id,run_id,session_id,agent_type,description) VALUES(?,?,?,?,?)').run(fi.agentId, fi.workflowRunId, fi.sessionId, meta.agentType||null, meta.description||null);
    } else {
      db.prepare('INSERT OR REPLACE INTO subagents VALUES(?,?,?,?,?,?,?)').run(fi.agentId, fi.sessionId, meta.toolUseId||null, meta.agentType||null, meta.description||null, dur, tok?.t||0);
    }
  } catch (error) {
    console.warn(`Warning: failed to read subagent meta ${mp}: ${error.message}`);
  }
}

function indexWorkflows(db, { projectsDir = DEFAULT_PROJECTS_DIR } = {}) {
  if (!fs.existsSync(projectsDir)) return;
  let projects;
  try { projects = fs.readdirSync(projectsDir); } catch { return; }
  for (const proj of projects) {
    const pp = path.join(projectsDir, proj);
    if (!isDir(pp)) continue;
    let entries;
    try { entries = fs.readdirSync(pp); } catch { continue; }
    for (const sd of entries) {
      const wd = path.join(pp, sd, 'workflows');
      if (!isDir(wd)) continue;
      let wfFiles;
      try { wfFiles = fs.readdirSync(wd); } catch { continue; }
      for (const f of wfFiles) {
        if (!f.endsWith('.json')) continue;
        try {
          const wf = JSON.parse(fs.readFileSync(path.join(wd, f), 'utf8'));
          if (!wf.runId) continue;
          const ac = db.prepare('SELECT COUNT(*) as c FROM workflow_agents WHERE run_id=?').get(wf.runId);
          db.prepare('INSERT OR REPLACE INTO workflows (run_id,session_id,task_id,script,result_json,timestamp,agent_count,duration_ms,total_tokens,status,workflow_name) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
            wf.runId, sd, wf.taskId||null, wf.script||null,
            wf.result ? JSON.stringify(wf.result) : null, wf.timestamp||null, ac?.c||0,
            wf.durationMs||null, wf.totalTokens||null, wf.status||null, wf.workflowName||null);
          const progress = wf.workflowProgress || [];
          for (const item of progress) {
            if (item.type !== 'workflow_agent' || !item.agentId) continue;
            db.prepare('UPDATE workflow_agents SET phase=?, label=?, model=?, state=?, duration_ms=?, tokens=?, tool_calls=? WHERE agent_id=?').run(
              item.phaseTitle||null, item.label||null, item.model||null, item.state||null,
              item.durationMs||null, item.tokens||null, item.toolCalls||null, 'agent-' + item.agentId);
          }
        } catch (error) {
          console.warn(`Warning: failed to index workflow ${f}: ${error.message}`);
        }
      }
    }
  }
}

function indexHistory(db, { historyPath = DEFAULT_HISTORY_PATH } = {}) {
  if (!fs.existsSync(historyPath)) return;
  readLines(historyPath, (line) => {
    try {
      const o = JSON.parse(line);
      if (o.sessionId && o.title) db.prepare('UPDATE sessions SET title=? WHERE id=? AND title IS NULL').run(o.title, o.sessionId);
    } catch (error) {
      console.warn(`Warning: malformed history line: ${error.message}`);
    }
  });
}

function rebuildFts(db) {
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
}

function writeIndexMarker(db, key, value = Date.now()) {
  db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)').run(key, value);
}

function writeHeartbeat({ dbPath = DEFAULT_DB_PATH, DatabaseImpl = Database } = {}) {
  if (!fs.existsSync(dbPath)) return;
  const db = new DatabaseImpl(dbPath);
  try {
    writeIndexMarker(db, '__app_heartbeat__');
  } finally {
    db.close();
  }
}

function buildIndex({
  claudeDir = DEFAULT_CLAUDE_DIR,
  projectsDir = path.join(claudeDir, 'projects'),
  historyPath = path.join(claudeDir, 'history.jsonl'),
  dbPath = path.join(claudeDir, 'obelisk.sqlite'),
  schemaPath = resolveSchemaPath(),
  DatabaseImpl = Database,
  force = false,
} = {}) {
  const db = openIndexDb({ dbPath, schemaPath, DatabaseImpl });
  const files = discoverJsonlFiles({ projectsDir });
  const latestSourceMtime = files.reduce((latest, file) => {
    try {
      return Math.max(latest, fs.statSync(file.path).mtimeMs);
    } catch {
      return latest;
    }
  }, 0);

  try {
    if (force) db.prepare("DELETE FROM index_state WHERE jsonl_path NOT LIKE '__%'").run();
    for (const file of files) {
      db.exec('BEGIN');
      try {
        indexJsonl(db, file);
        indexSubagentMeta(db, file);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        console.warn(`Warning: failed to index ${file.path}: ${error.message}`);
      }
    }
    db.exec('BEGIN');
    try {
      indexWorkflows(db, { projectsDir });
      refreshSessionProjectPaths(db);
      indexHistory(db, { historyPath });
      rebuildFts(db);
      writeIndexMarker(db, '__last_build__');
      writeIndexMarker(db, '__app_heartbeat__');
      writeIndexMarker(db, '__app_last_successful_build__');
      writeIndexMarker(db, '__indexer_owner_app__');
      if (latestSourceMtime) writeIndexMarker(db, '__last_source_mtime__', latestSourceMtime);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { files: files.length, latestSourceMtime };
  } finally {
    db.close();
  }
}

module.exports = {
  buildIndex,
  writeHeartbeat,
  openIndexDb,
  discoverJsonlFiles,
  inferProjectPath,
};
