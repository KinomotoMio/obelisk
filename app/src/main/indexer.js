const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const TEXT_LIMIT = 10000;
const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');
const DEFAULT_OBELISK_DIR = path.join(os.homedir(), '.obelisk');
const DEFAULT_DB_PATH = path.join(DEFAULT_OBELISK_DIR, 'obelisk.sqlite');
const DEFAULT_PROJECTS_DIR = path.join(DEFAULT_CLAUDE_DIR, 'projects');
const DEFAULT_HISTORY_PATH = path.join(DEFAULT_CLAUDE_DIR, 'history.jsonl');

function resolveSchemaPath() {
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', '..', '..', 'scripts', 'schema.sql'),
    process.resourcesPath ? path.join(process.resourcesPath, 'scripts', 'schema.sql') : null,
  ].filter(Boolean);
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error('Obelisk schema.sql not found');
  return found;
}

function installSchema(db, schemaPath = resolveSchemaPath()) {
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrateDb(db);
}

function openIndexDb({ dbPath = DEFAULT_DB_PATH, schemaPath = resolveSchemaPath(), DatabaseImpl = Database } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseImpl(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  installSchema(db, schemaPath);
  return db;
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateDb(db) {
  ensureColumn(db, 'sessions', 'source', "TEXT DEFAULT 'claude'");
  ensureColumn(db, 'messages', 'content_type', 'TEXT');
  ensureColumn(db, 'messages', 'is_meta', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'messages', 'source', "TEXT DEFAULT 'claude'");
  ensureColumn(db, 'memories', 'anchors', 'TEXT');
  ensureColumn(db, 'memories', 'deleted_at', 'TEXT');
  ensureColumn(db, 'memories', 'deleted_reason', 'TEXT');
}

function copyMemoriesFromDb(db, sourceDbPath) {
  if (!sourceDbPath || !fs.existsSync(sourceDbPath)) return false;
  db.prepare('ATTACH DATABASE ? AS previous_obelisk').run(sourceDbPath);
  try {
    const hasMemories = db.prepare(`
      SELECT name FROM previous_obelisk.sqlite_master
      WHERE type='table' AND name='memories'
    `).get();
    if (!hasMemories) return false;

    const sourceColumns = new Set(
      db.prepare('PRAGMA previous_obelisk.table_info(memories)').all().map(column => column.name),
    );
    const targetColumns = [
      'id',
      'session_id',
      'project',
      'message_start',
      'message_end',
      'path',
      'anchors',
      'summary',
      'created_at',
      'deleted_at',
      'deleted_reason',
    ];
    const selectList = targetColumns
      .map(column => sourceColumns.has(column) ? column : `NULL AS ${column}`)
      .join(',');
    db.exec(`
      INSERT OR REPLACE INTO memories (${targetColumns.join(',')})
      SELECT ${selectList} FROM previous_obelisk.memories
    `);
    return true;
  } finally {
    db.exec('DETACH DATABASE previous_obelisk');
  }
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

const COMMAND_ENVELOPE_RE = /^\s*(<command-name>[^<]+<\/command-name>|<(?:task-notification|system-reminder)\b|<local-command(?:\b|-))/;

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

function projectSlugFromPath(projectPath) {
  const normalized = normalizeObservedCwd(projectPath);
  if (!normalized) return null;
  return '-' + normalized.replace(/^[\\/]+/, '').replace(/[\\/]+/g, '-');
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

function discoverJsonlFiles({ projectsDir = DEFAULT_PROJECTS_DIR, changedPaths = undefined } = {}) {
  if (Array.isArray(changedPaths) && changedPaths.length) {
    const changedFiles = discoverJsonlFilesForChanges({ projectsDir, changedPaths });
    if (changedFiles.length) return changedFiles;
  }
  return discoverJsonlFilesFull({ projectsDir });
}

function normalizeChangedPath(projectsDir, changedPath) {
  if (!changedPath) return null;
  const raw = String(changedPath);
  return path.isAbsolute(raw) ? path.normalize(raw) : path.normalize(path.join(projectsDir, raw));
}

function jsonlFileInfoFromPath(projectsDir, changedPath) {
  const fp = normalizeChangedPath(projectsDir, changedPath);
  if (!fp || !fp.endsWith('.jsonl')) return null;
  if (!fs.existsSync(fp)) return null;
  const rel = path.relative(projectsDir, fp);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  const project = parts[0];
  if (!project) return null;
  if (parts.length === 2) {
    const filename = parts[1];
    return { path: fp, sessionId: filename.slice(0, -6), project, isSubagent: false };
  }
  if (parts.length === 4 && parts[2] === 'subagents') {
    const filename = parts[3];
    return { path: fp, sessionId: parts[1], project, isSubagent: true, agentId: filename.slice(0, -6) };
  }
  if (parts.length === 6 && parts[2] === 'subagents' && parts[3] === 'workflows') {
    const filename = parts[5];
    return {
      path: fp,
      sessionId: parts[1],
      project,
      isSubagent: true,
      agentId: filename.slice(0, -6),
      workflowRunId: parts[4],
    };
  }
  return null;
}

function sessionIdFromChangedPath(projectsDir, changedPath) {
  const fp = normalizeChangedPath(projectsDir, changedPath);
  if (!fp) return null;
  const rel = path.relative(projectsDir, fp);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
    return fs.existsSync(fp) ? parts[1].slice(0, -6) : null;
  }
  if (parts.length >= 3) return fs.existsSync(fp) ? parts[1] || null : null;
  return null;
}

function dedupeFileInfos(files) {
  const byPath = new Map();
  for (const file of files) byPath.set(file.path, file);
  return [...byPath.values()];
}

function discoverJsonlFilesForChanges({ projectsDir = DEFAULT_PROJECTS_DIR, changedPaths = [] } = {}) {
  const files = [];
  for (const changedPath of changedPaths) {
    const info = jsonlFileInfoFromPath(projectsDir, changedPath);
    if (info) files.push(info);
  }
  return dedupeFileInfos(files);
}

function discoverJsonlFilesFull({ projectsDir = DEFAULT_PROJECTS_DIR } = {}) {
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

function discoverCodexJsonlFiles({ codexDir = DEFAULT_CODEX_DIR, changedPaths = undefined } = {}) {
  if (Array.isArray(changedPaths) && changedPaths.length) {
    const changedFiles = discoverCodexJsonlFilesForChanges({ codexDir, changedPaths });
    if (changedFiles.length) return changedFiles;
    return [];
  }
  return discoverCodexJsonlFilesFull({ codexDir });
}

function codexSessionsDir(codexDir = DEFAULT_CODEX_DIR) {
  return path.join(codexDir, 'sessions');
}

function normalizeChangedPathForRoot(rootDir, changedPath) {
  if (!changedPath) return null;
  const raw = String(changedPath);
  return path.isAbsolute(raw) ? path.normalize(raw) : path.normalize(path.join(rootDir, raw));
}

function isPathInside(rootDir, candidate) {
  if (!rootDir || !candidate) return false;
  const rel = path.relative(rootDir, candidate);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function discoverCodexJsonlFilesForChanges({ codexDir = DEFAULT_CODEX_DIR, changedPaths = [] } = {}) {
  const files = [];
  const sessionsDir = codexSessionsDir(codexDir);
  for (const changedPath of changedPaths) {
    const rootRelativePath = normalizeChangedPathForRoot(codexDir, changedPath);
    if (!rootRelativePath) continue;
    if (path.normalize(rootRelativePath) === path.join(codexDir, 'session_index.jsonl')) {
      return discoverCodexJsonlFilesFull({ codexDir });
    }
    const sessionRelativePath = normalizeChangedPathForRoot(sessionsDir, changedPath);
    const fp = isPathInside(sessionsDir, rootRelativePath) ? rootRelativePath : sessionRelativePath;
    if (!fp.endsWith('.jsonl') || !isPathInside(sessionsDir, fp)) continue;
    if (!fs.existsSync(fp)) continue;
    files.push({ path: fp, source: 'codex' });
  }
  return dedupeFileInfos(files);
}

function discoverCodexJsonlFilesFull({ codexDir = DEFAULT_CODEX_DIR } = {}) {
  const root = codexSessionsDir(codexDir);
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fp = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fp);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({ path: fp, source: 'codex' });
      }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
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
    ses: db.prepare('INSERT OR REPLACE INTO sessions (id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    msg: db.prepare(`
      INSERT INTO messages (uuid,session_id,type,parent_uuid,timestamp,role,text,content_type,is_meta,model,is_sidechain,agent_id,input_tokens,output_tokens,cwd,skill,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(uuid) DO UPDATE SET
        session_id=excluded.session_id,
        type=excluded.type,
        parent_uuid=excluded.parent_uuid,
        timestamp=excluded.timestamp,
        role=excluded.role,
        text=excluded.text,
        content_type=excluded.content_type,
        is_meta=excluded.is_meta,
        model=excluded.model,
        is_sidechain=excluded.is_sidechain,
        agent_id=excluded.agent_id,
        input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens,
        cwd=excluded.cwd,
        skill=excluded.skill,
        source=excluded.source
    `),
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
    n: skip > 0 ? (existing?.message_count || 0) : 0,
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
        obj.cwd || null, obj.attributionSkill || null, 'claude');
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
    ins.ses.run(fi.sessionId, sm.title, fi.project, pp, sm.started_at, sm.ended_at, sm.git_branch, sm.version, sm.n, fi.path, 'claude');
  }
  ins.idx.run(fi.path, mtime, lineNum);
  return { sessionId: fi.sessionId, path: fi.path };
}

function codexDbId(id) {
  if (!id) return null;
  const raw = String(id).replace(/^codex:/, '');
  return `codex:${raw}`;
}

function codexRawId(id) {
  return id ? String(id).replace(/^codex:/, '') : null;
}

function codexLineUuid(threadId, lineNum) {
  return `codex:${codexRawId(threadId)}:${String(lineNum).padStart(6, '0')}`;
}

function codexCallId(callId) {
  if (!callId) return null;
  return `codex:${String(callId).replace(/^codex:/, '')}`;
}

function codexParentThreadId(meta) {
  const subagent = meta?.source?.subagent;
  return subagent?.thread_spawn?.parent_thread_id
    || meta?.forked_from_id
    || subagent?.parent_thread_id
    || null;
}

function codexIsGuardianThread(meta, records = []) {
  const subagent = meta?.source?.subagent;
  if (subagent?.other === 'guardian') return true;
  if (meta?.thread_source !== 'subagent') return false;
  return records.some(({ obj }) => obj?.payload?.model === 'codex-auto-review' || obj?.model === 'codex-auto-review');
}

function deleteCodexThreadRows(db, threadRawId) {
  const threadId = codexDbId(threadRawId);
  if (!threadId) return;
  db.prepare(`
    DELETE FROM tool_results
    WHERE session_id = ?
       OR message_uuid IN (SELECT uuid FROM messages WHERE session_id = ? OR agent_id = ?)
  `).run(threadId, threadId, threadId);
  db.prepare(`
    DELETE FROM tool_calls
    WHERE session_id = ?
       OR message_uuid IN (SELECT uuid FROM messages WHERE session_id = ? OR agent_id = ?)
  `).run(threadId, threadId, threadId);
  db.prepare('DELETE FROM messages WHERE session_id = ? OR agent_id = ?').run(threadId, threadId);
  db.prepare('DELETE FROM subagents WHERE agent_id = ? OR session_id = ?').run(threadId, threadId);
  db.prepare('DELETE FROM summaries WHERE session_id = ?').run(threadId);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(threadId);
}

function readCodexGuardianThreadInfo(filePath) {
  const records = [];
  let metaRecord = null;
  let lineNum = 0;
  readLines(filePath, (line) => {
    lineNum++;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    records.push({ lineNum, obj });
    if (obj?.type === 'session_meta' && obj.payload?.id) {
      metaRecord = { lineNum, obj };
      if (obj.payload?.source?.subagent?.other === 'guardian') return false;
      if (obj.payload?.thread_source !== 'subagent') return false;
    }
    if (metaRecord && codexIsGuardianThread(metaRecord.obj.payload, records)) return false;
  });
  const meta = metaRecord?.obj?.payload;
  if (!meta || !codexIsGuardianThread(meta, records)) return null;
  return { threadRawId: codexRawId(meta.id), lineNum };
}

function codexAgentNickname(meta) {
  return meta?.agent_nickname
    || meta?.source?.subagent?.thread_spawn?.agent_nickname
    || null;
}

function codexAgentRole(meta) {
  return meta?.agent_role
    || meta?.source?.subagent?.thread_spawn?.agent_role
    || null;
}

function parseCodexJsonInput(value) {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function codexUsage(payload) {
  const usage = payload?.info?.last_token_usage || payload?.info?.total_token_usage || payload?.last_token_usage || null;
  if (!usage) return {};
  return {
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
  };
}

function codexEventText(payload) {
  if (typeof payload?.message === 'string') return payload.message;
  if (Array.isArray(payload?.text_elements) && payload.text_elements.length) {
    const parts = payload.text_elements.map(item => typeof item === 'string' ? item : item?.text).filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  if (typeof payload?.text === 'string') return payload.text;
  return null;
}

function codexMessagePayloadText(payload) {
  if (!Array.isArray(payload?.content)) return null;
  const parts = [];
  for (const block of payload.content) {
    if (typeof block?.text === 'string') parts.push(block.text);
  }
  return parts.length ? parts.join('\n') : null;
}

function codexVisibleMessageKey(role, text) {
  return `${role || ''}\u0000${text || ''}`;
}

function codexToolInput(payload) {
  if (payload?.type === 'custom_tool_call') return parseCodexJsonInput(payload.input);
  if (payload?.type === 'tool_search_call') return parseCodexJsonInput(payload.arguments);
  if (payload?.type === 'web_search_call') return { action: payload.action || null };
  return parseCodexJsonInput(payload?.arguments);
}

function codexToolOutput(payload) {
  if (typeof payload?.output === 'string') return payload.output;
  if (payload?.output !== undefined) return JSON.stringify(payload.output);
  if (payload?.tools !== undefined) return JSON.stringify(payload.tools);
  if (payload?.execution !== undefined) return JSON.stringify(payload.execution);
  return null;
}

function upsertCodexSubagent(db, {
  agentId,
  sessionId,
  parentToolUseId = null,
  agentType = null,
  description = null,
  durationMs = null,
  totalTokens = null,
} = {}) {
  if (!agentId || !sessionId) return;
  db.prepare(`
    INSERT INTO subagents (agent_id,session_id,parent_tool_use_id,agent_type,description,duration_ms,total_tokens)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(agent_id) DO UPDATE SET
      session_id=excluded.session_id,
      parent_tool_use_id=COALESCE(excluded.parent_tool_use_id, subagents.parent_tool_use_id),
      agent_type=COALESCE(excluded.agent_type, subagents.agent_type),
      description=COALESCE(excluded.description, subagents.description),
      duration_ms=COALESCE(excluded.duration_ms, subagents.duration_ms),
      total_tokens=COALESCE(excluded.total_tokens, subagents.total_tokens)
  `).run(agentId, sessionId, parentToolUseId, agentType, description, durationMs, totalTokens);
}

function indexCodexJsonl(db, fi) {
  const state = needsReindex(db, fi.path);
  if (!state.needed) {
    const guardian = readCodexGuardianThreadInfo(fi.path);
    if (guardian) deleteCodexThreadRows(db, guardian.threadRawId);
    return null;
  }
  const mtime = state.mtime;
  const records = [];
  let lineNum = 0;
  readLines(fi.path, (line) => {
    lineNum++;
    try {
      records.push({ lineNum, obj: JSON.parse(line) });
    } catch {}
  });

  const metaRecord = records.find(r => r.obj?.type === 'session_meta' && r.obj.payload?.id);
  if (!metaRecord) {
    db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,?,?)').run(fi.path, mtime, lineNum);
    return null;
  }

  const meta = metaRecord.obj.payload;
  const threadRawId = codexRawId(meta.id);
  if (codexIsGuardianThread(meta, records)) {
    deleteCodexThreadRows(db, threadRawId);
    db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,?,?)').run(fi.path, mtime, lineNum);
    return null;
  }
  const parentRawId = codexParentThreadId(meta);
  const sessionId = codexDbId(parentRawId || threadRawId);
  const agentId = parentRawId ? codexDbId(threadRawId) : null;
  const isSidechain = agentId ? 1 : 0;
  const projectPath = normalizeObservedCwd(meta.cwd);
  const project = projectSlugFromPath(projectPath);
  const sm = {
    started_at: meta.timestamp || metaRecord.obj.timestamp || null,
    ended_at: meta.timestamp || metaRecord.obj.timestamp || null,
    git_branch: meta.git?.branch || null,
    version: meta.cli_version || null,
    title: null,
    n: 0,
    cwds: projectPath ? [projectPath] : [],
    lastMessageUuid: null,
    lastTextAssistantUuid: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  const ins = {
    ses: db.prepare('INSERT OR REPLACE INTO sessions (id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    msg: db.prepare(`
      INSERT INTO messages (uuid,session_id,type,parent_uuid,timestamp,role,text,content_type,is_meta,model,is_sidechain,agent_id,input_tokens,output_tokens,cwd,skill,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(uuid) DO UPDATE SET
        session_id=excluded.session_id,
        type=excluded.type,
        parent_uuid=excluded.parent_uuid,
        timestamp=excluded.timestamp,
        role=excluded.role,
        text=excluded.text,
        content_type=excluded.content_type,
        is_meta=excluded.is_meta,
        model=excluded.model,
        is_sidechain=excluded.is_sidechain,
        agent_id=excluded.agent_id,
        input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens,
        cwd=excluded.cwd,
        skill=excluded.skill,
        source=excluded.source
    `),
    tc: db.prepare('INSERT OR REPLACE INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path) VALUES (?,?,?,?,?,?)'),
    tr: db.prepare('INSERT OR REPLACE INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path,is_error) VALUES (?,?,?,?,?,?)'),
    idx: db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,?,?)'),
    dur: db.prepare('UPDATE messages SET turn_duration_ms=? WHERE uuid=?'),
    usage: db.prepare('UPDATE messages SET input_tokens=?, output_tokens=? WHERE uuid=?'),
  };

  let currentCwd = projectPath;
  let currentModel = null;
  const eventMessageKeys = new Set();
  const callMessageUuids = new Map();

  for (const { obj } of records) {
    if (obj?.type !== 'event_msg') continue;
    const payload = obj.payload || {};
    if (payload.type !== 'user_message' && payload.type !== 'agent_message') continue;
    const text = codexEventText(payload);
    if (text === null) continue;
    eventMessageKeys.add(codexVisibleMessageKey(payload.type === 'user_message' ? 'user' : 'assistant', text));
  }

  const updateBounds = (ts) => {
    if (!ts) return;
    if (!sm.started_at || ts < sm.started_at) sm.started_at = ts;
    if (!sm.ended_at || ts > sm.ended_at) sm.ended_at = ts;
  };

  const insertMessage = ({ uuid, type, role, text = null, contentType = 'text', timestamp, isMeta = 0 }) => {
    ins.msg.run(
      uuid,
      sessionId,
      type,
      sm.lastMessageUuid,
      timestamp || null,
      role,
      trunc(text),
      contentType,
      isMeta,
      currentModel,
      isSidechain,
      agentId,
      null,
      null,
      currentCwd,
      null,
      'codex',
    );
    sm.lastMessageUuid = uuid;
    if (!agentId) sm.n++;
    if (type === 'assistant' && contentType === 'text') sm.lastTextAssistantUuid = uuid;
    updateBounds(timestamp);
    return uuid;
  };

  for (const { lineNum: currentLine, obj } of records) {
    const ts = obj.timestamp || null;
    if (obj.type === 'session_meta') {
      if (obj.payload?.cwd) {
        currentCwd = normalizeObservedCwd(obj.payload.cwd) || currentCwd;
        if (currentCwd) sm.cwds.push(currentCwd);
      }
      if (obj.payload?.git?.branch) sm.git_branch = obj.payload.git.branch;
      if (obj.payload?.cli_version) sm.version = obj.payload.cli_version;
      updateBounds(obj.payload?.timestamp || ts);
      continue;
    }
    if (obj.type === 'turn_context') {
      currentCwd = normalizeObservedCwd(obj.payload?.cwd) || currentCwd;
      currentModel = obj.payload?.model || currentModel;
      if (currentCwd) sm.cwds.push(currentCwd);
      updateBounds(ts);
      continue;
    }
    if (obj.type === 'event_msg') {
      const payload = obj.payload || {};
      if (payload.type === 'user_message' || payload.type === 'agent_message' || payload.type === 'agent_reasoning') {
        const text = codexEventText(payload);
        if (text === null) continue;
        const isReasoning = payload.type === 'agent_reasoning';
        insertMessage({
          uuid: codexLineUuid(threadRawId, currentLine),
          type: payload.type === 'user_message' ? 'user' : 'assistant',
          role: payload.type === 'user_message' ? 'user' : 'assistant',
          text,
          contentType: isReasoning ? 'thinking' : 'text',
          timestamp: ts,
        });
        continue;
      }
      if (payload.type === 'collab_agent_spawn_end' && payload.call_id && payload.new_thread_id) {
        const uuid = insertMessage({
          uuid: codexLineUuid(threadRawId, currentLine),
          type: 'assistant',
          role: 'assistant',
          text: null,
          contentType: 'tool_use',
          timestamp: ts,
        });
        const toolId = codexCallId(payload.call_id);
        const description = payload.new_agent_nickname || payload.new_agent_role || 'Agent';
        const input = {
          description,
          subagent_type: payload.new_agent_role || 'Agent',
          prompt: payload.prompt || '',
          new_thread_id: payload.new_thread_id,
          model: payload.model || null,
          reasoning_effort: payload.reasoning_effort || null,
        };
        ins.tc.run(toolId, uuid, sessionId, 'Agent', truncJson(input), null);
        callMessageUuids.set(toolId, uuid);
        upsertCodexSubagent(db, {
          agentId: codexDbId(payload.new_thread_id),
          sessionId,
          parentToolUseId: toolId,
          agentType: payload.new_agent_role || null,
          description,
        });
        continue;
      }
      if (payload.type === 'task_complete') {
        if (sm.lastTextAssistantUuid && payload.duration_ms !== undefined) {
          ins.dur.run(payload.duration_ms || null, sm.lastTextAssistantUuid);
        }
        updateBounds(ts);
        continue;
      }
      if (payload.type === 'token_count') {
        const usage = codexUsage(payload);
        if (usage.inputTokens !== null) sm.totalInputTokens = usage.inputTokens;
        if (usage.outputTokens !== null) sm.totalOutputTokens = usage.outputTokens;
        if (sm.lastTextAssistantUuid && (usage.inputTokens !== null || usage.outputTokens !== null)) {
          ins.usage.run(usage.inputTokens, usage.outputTokens, sm.lastTextAssistantUuid);
        }
        continue;
      }
      if (payload.type === 'thread_name_updated' && payload.thread_name) {
        sm.title = payload.thread_name;
      }
      continue;
    }
    if (obj.type !== 'response_item') continue;
    const payload = obj.payload || {};
    if (payload.type === 'message' && payload.role !== 'developer') {
      const text = codexMessagePayloadText(payload);
      const role = payload.role || 'assistant';
      if (text !== null && !eventMessageKeys.has(codexVisibleMessageKey(role, text))) {
        insertMessage({
          uuid: codexLineUuid(threadRawId, currentLine),
          type: role === 'user' ? 'user' : 'assistant',
          role,
          text,
          contentType: 'text',
          timestamp: ts,
        });
      }
      continue;
    }
    if (['function_call', 'custom_tool_call', 'tool_search_call', 'web_search_call'].includes(payload.type) && payload.call_id) {
      const uuid = insertMessage({
        uuid: codexLineUuid(threadRawId, currentLine),
        type: 'assistant',
        role: 'assistant',
        text: null,
        contentType: 'tool_use',
        timestamp: ts,
      });
      const name = payload.name || payload.tool || payload.type.replace(/_call$/, '');
      const toolId = codexCallId(payload.call_id);
      ins.tc.run(toolId, uuid, sessionId, name, truncJson(codexToolInput(payload)), null);
      callMessageUuids.set(toolId, uuid);
      continue;
    }
    if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(payload.type) && payload.call_id) {
      const toolId = codexCallId(payload.call_id);
      ins.tr.run(toolId, callMessageUuids.get(toolId) || null, sessionId, trunc(codexToolOutput(payload) || ''), null, payload.is_error ? 1 : 0);
    }
  }

  if (agentId) {
    const tokenTotal = (sm.totalInputTokens || 0) + (sm.totalOutputTokens || 0);
    const started = sm.started_at ? new Date(sm.started_at).getTime() : null;
    const ended = sm.ended_at ? new Date(sm.ended_at).getTime() : null;
    upsertCodexSubagent(db, {
      agentId,
      sessionId,
      agentType: codexAgentRole(meta),
      description: codexAgentNickname(meta),
      durationMs: started && ended ? ended - started : null,
      totalTokens: tokenTotal || null,
    });
  } else {
    const pp = inferProjectPath(project, sm.cwds);
    ins.ses.run(sessionId, sm.title, project, pp, sm.started_at, sm.ended_at, sm.git_branch, sm.version, sm.n, fi.path, 'codex');
  }
  ins.idx.run(fi.path, mtime, lineNum);
  return { sessionId, path: fi.path };
}

function indexCodexSessionIndex(db, { codexDir = DEFAULT_CODEX_DIR } = {}) {
  const indexPath = path.join(codexDir, 'session_index.jsonl');
  if (!fs.existsSync(indexPath)) return;
  readLines(indexPath, (line) => {
    try {
      const item = JSON.parse(line);
      if (!item.id || !item.thread_name) return;
      db.prepare('UPDATE sessions SET title=COALESCE(title, ?), ended_at=COALESCE(ended_at, ?) WHERE id=? AND source=?')
        .run(item.thread_name, item.updated_at || null, codexDbId(item.id), 'codex');
    } catch (error) {
      console.warn(`Warning: malformed Codex session index line: ${error.message}`);
    }
  });
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

function checkpointDb(db) {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {}
}

const MESSAGE_FTS_TRIGGERS = [
  'messages_fts_ai',
  'messages_fts_ad',
  'messages_fts_au',
];

function dropMessageFtsTriggers(db) {
  for (const trigger of MESSAGE_FTS_TRIGGERS) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
}

function ensureFtsReady(db, { force = false } = {}) {
  const marker = '__fts_triggers_ready__';
  const ready = db.prepare('SELECT jsonl_path FROM index_state WHERE jsonl_path = ?').get(marker);
  if (ready && !force) return false;
  rebuildFts(db);
  writeIndexMarker(db, marker);
  return true;
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
  codexDir = path.join(path.dirname(claudeDir), '.codex'),
  projectsDir = path.join(claudeDir, 'projects'),
  historyPath = path.join(claudeDir, 'history.jsonl'),
  dbPath = DEFAULT_DB_PATH,
  schemaPath = resolveSchemaPath(),
  DatabaseImpl = Database,
  force = false,
  changedPaths = undefined,
  preserveDbPath = null,
} = {}) {
  const db = openIndexDb({ dbPath, schemaPath, DatabaseImpl });
  let messageFtsTriggersDropped = false;
  if (preserveDbPath && path.resolve(preserveDbPath) !== path.resolve(dbPath)) {
    copyMemoriesFromDb(db, preserveDbPath);
  }
  const files = [
    ...discoverJsonlFiles({ projectsDir, changedPaths: force ? undefined : changedPaths }),
    ...discoverCodexJsonlFiles({ codexDir, changedPaths: force ? undefined : changedPaths }),
  ];
  const latestSourceMtime = files.reduce((latest, file) => {
    try {
      return Math.max(latest, fs.statSync(file.path).mtimeMs);
    } catch {
      return latest;
    }
  }, 0);

  try {
    if (force) {
      dropMessageFtsTriggers(db);
      messageFtsTriggersDropped = true;
      db.prepare("DELETE FROM index_state WHERE substr(jsonl_path, 1, 2) != '__'").run();
      db.prepare("DELETE FROM messages").run();
      db.prepare("DELETE FROM tool_calls").run();
      db.prepare("DELETE FROM tool_results").run();
      db.prepare("DELETE FROM sessions").run();
      db.prepare("DELETE FROM summaries").run();
      db.prepare("DELETE FROM subagents").run();
      db.prepare("DELETE FROM workflows").run();
      db.prepare("DELETE FROM workflow_agents").run();
    }
    const affectedSessionIds = new Set();
    if (Array.isArray(changedPaths)) {
      for (const changedPath of changedPaths) {
        const sessionId = sessionIdFromChangedPath(projectsDir, changedPath);
        if (sessionId) affectedSessionIds.add(sessionId);
      }
    }
    for (const file of files) {
      db.exec('BEGIN');
      try {
        const indexed = file.source === 'codex' ? indexCodexJsonl(db, file) : indexJsonl(db, file);
        if (indexed?.sessionId) affectedSessionIds.add(indexed.sessionId);
        if (file.source !== 'codex') indexSubagentMeta(db, file);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        console.warn(`Warning: failed to index ${file.path}: ${error.message}`);
      }
    }
    db.exec('BEGIN');
    let ftsRebuilt = false;
    try {
      indexWorkflows(db, { projectsDir });
      refreshSessionProjectPaths(db);
      indexHistory(db, { historyPath });
      indexCodexSessionIndex(db, { codexDir });
      if (messageFtsTriggersDropped) installSchema(db, schemaPath);
      ftsRebuilt = ensureFtsReady(db, { force });
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
    return { files: files.length, latestSourceMtime, affectedSessionIds: [...affectedSessionIds], ftsRebuilt };
  } finally {
    if (messageFtsTriggersDropped) {
      try {
        installSchema(db, schemaPath);
      } catch (error) {
        console.warn(`Warning: failed to restore message FTS triggers: ${error.message}`);
      }
    }
    checkpointDb(db);
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
