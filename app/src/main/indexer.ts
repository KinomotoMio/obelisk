import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { parse as claudeParse } from '../../../packages/core/src/providers/claude.ts';
import { parse as codexParse } from '../../../packages/core/src/providers/codex.ts';
import { persist } from '../../../packages/core/src/persist.ts';
import { runWriteTransaction, configureConnection, betterSqliteTransactionAdapter } from '../../../packages/core/src/tx.ts';
import { acquireWriterLease, writerLockPathFor } from '../../../packages/core/src/writer-lease.ts';
import { runRetryableWriteTransaction, isBeginBusyFailure, hasUnusableTransaction } from '../../../packages/core/src/write-coordinator.ts';
import {
  inferProjectPath,
  isDir,
  readLines,
  codexDbId,
  codexRawId,
  codexParentThreadId,
  readCodexGuardianThreadInfo,
} from '../../../packages/core/src/parsing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');
const DEFAULT_OBELISK_DIR = path.join(os.homedir(), '.obelisk');
const DEFAULT_DB_PATH = path.join(DEFAULT_OBELISK_DIR, 'obelisk.sqlite');
const DEFAULT_PROJECTS_DIR = path.join(DEFAULT_CLAUDE_DIR, 'projects');
const DEFAULT_HISTORY_PATH = path.join(DEFAULT_CLAUDE_DIR, 'history.jsonl');

interface FileInfo {
  path: string;
  sessionId?: string;
  project?: string;
  isSubagent?: boolean;
  agentId?: string;
  workflowRunId?: string;
  source?: string;
}

function resolveSchemaPath() {
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', '..', '..', 'scripts', 'schema.sql'),
    process.resourcesPath ? path.join(process.resourcesPath, 'scripts', 'schema.sql') : null,
  ].filter((c): c is string => Boolean(c));
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error('Obelisk schema.sql not found');
  return found;
}

function installSchema(db, schemaPath = resolveSchemaPath()) {
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrateDb(db);
}

function openIndexDb({ dbPath = DEFAULT_DB_PATH, schemaPath = resolveSchemaPath(), DatabaseImpl = Database }: { dbPath?: string; schemaPath?: string; DatabaseImpl?: new (dbPath: string) => any } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseImpl(dbPath);
  configureConnection(db, { busyTimeoutMs: 250 });
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

function discoverJsonlFiles({ projectsDir = DEFAULT_PROJECTS_DIR, changedPaths = undefined }: { projectsDir?: string; changedPaths?: string[] } = {}) {
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
  let fp = normalizeChangedPath(projectsDir, changedPath);
  if (fp?.toLowerCase().endsWith('.meta.json')) {
    fp = fp.slice(0, -'.meta.json'.length) + '.jsonl';
  }
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

function discoverJsonlFilesForChanges({ projectsDir = DEFAULT_PROJECTS_DIR, changedPaths = [] }: { projectsDir?: string; changedPaths?: string[] } = {}) {
  const files: FileInfo[] = [];
  for (const changedPath of changedPaths) {
    const info = jsonlFileInfoFromPath(projectsDir, changedPath);
    if (info) files.push(info);
  }
  return dedupeFileInfos(files);
}

function discoverJsonlFilesFull({ projectsDir = DEFAULT_PROJECTS_DIR } = {}) {
  const files: FileInfo[] = [];
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

function discoverCodexJsonlFiles({ codexDir = DEFAULT_CODEX_DIR, changedPaths = undefined }: { codexDir?: string; changedPaths?: string[] } = {}) {
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

function discoverCodexJsonlFilesForChanges({ codexDir = DEFAULT_CODEX_DIR, changedPaths = [] }: { codexDir?: string; changedPaths?: string[] } = {}) {
  const files: FileInfo[] = [];
  const sessionsDir = codexSessionsDir(codexDir);
  for (const changedPath of changedPaths) {
    const rootRelativePath = normalizeChangedPathForRoot(codexDir, changedPath);
    if (!rootRelativePath) continue;
    if (path.normalize(rootRelativePath) === path.join(codexDir, 'session_index.jsonl')) {
      return discoverCodexJsonlFilesFull({ codexDir });
    }
    const sessionRelativePath = normalizeChangedPathForRoot(sessionsDir, changedPath);
    const fp = isPathInside(sessionsDir, rootRelativePath) ? rootRelativePath : sessionRelativePath;
    if (!fp || !fp.endsWith(".jsonl") || !isPathInside(sessionsDir, fp)) continue;
    if (!fs.existsSync(fp)) continue;
    files.push({ path: fp, source: 'codex' });
  }
  return dedupeFileInfos(files);
}

function discoverCodexJsonlFilesFull({ codexDir = DEFAULT_CODEX_DIR } = {}) {
  const root = codexSessionsDir(codexDir);
  const files: FileInfo[] = [];
  if (!fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
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

// Index one Claude transcript via the shared provider + persist core.
// Returns { sessionId, path } when reindexed, undefined when skipped.
function indexClaudeFile(db, file) {
  const { needed, skip, mtime } = needsReindex(db, file.path);
  if (!needed) return undefined;
  const unit = {
    key: file.path,
    sessionId: file.sessionId,
    project: file.project,
    isSubagent: file.isSubagent,
    agentId: file.agentId,
  };
  const cursor = skip > 0 ? `${mtime}:${skip}` : null;
  persist(db, unit, claudeParse(unit, cursor));
  return { sessionId: file.sessionId, path: file.path };
}

function codexSessionMeta(filePath) {
  let meta: any = null;
  readLines(filePath, (line) => {
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj?.type === 'session_meta' && obj.payload?.id) {
      meta = obj.payload;
      return false;
    }
  });
  return meta;
}

// Index one Codex rollout via the shared provider + persist core (full reparse).
// Returns { sessionId, path } when reindexed, undefined when skipped.
function indexCodexFile(db, file) {
  const { needed } = needsReindex(db, file.path);
  const guardian = readCodexGuardianThreadInfo(file.path);
  if (!needed) {
    if (guardian) {
      persist(db, { key: file.path, sessionId: '' }, (function* () {
        yield { kind: "delete-session", sessionId: codexDbId(guardian.threadRawId) as string };
        return null;
      })());
    }
    return undefined;
  }
  const unit = { key: file.path, sessionId: '' };
  persist(db, unit, codexParse(unit, null));
  if (guardian) return undefined;
  const meta = codexSessionMeta(file.path);
  const sessionId = meta ? codexDbId(codexParentThreadId(meta) || codexRawId(meta.id)) : undefined;
  return { sessionId, path: file.path };
}

function indexCodexSessionIndex(db, { codexDir = DEFAULT_CODEX_DIR } = {}) {
  const indexPath = path.join(codexDir, 'session_index.jsonl');
  if (!fs.existsSync(indexPath)) return;
  readLines(indexPath, (line) => {
    let item;
    try {
      item = JSON.parse(line);
    } catch (error) {
      console.warn(`Warning: malformed Codex session index line: ${(error as Error).message}`);
      return;
    }
    if (!item.id || !item.thread_name) return;
    db.prepare('UPDATE sessions SET title=COALESCE(title, ?), ended_at=COALESCE(ended_at, ?) WHERE id=? AND source=?')
      .run(item.thread_name, item.updated_at || null, codexDbId(item.id), 'codex');
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
  if (!fi.isSubagent) return false;
  const mp = fi.path.replace('.jsonl', '.meta.json');
  if (!fs.existsSync(mp)) return false;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  } catch (error) {
    console.warn(`Warning: failed to read subagent meta ${mp}: ${(error as Error).message}`);
    return false;
  }
  const tok = db.prepare('SELECT COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) as t FROM messages WHERE agent_id=?').get(fi.agentId);
  const ts = db.prepare('SELECT MIN(timestamp) as t0, MAX(timestamp) as t1 FROM messages WHERE agent_id=?').get(fi.agentId);
  const dur = ts?.t0 && ts?.t1 ? new Date(ts.t1).getTime() - new Date(ts.t0).getTime() : null;
  if (fi.workflowRunId) {
    db.prepare('INSERT OR REPLACE INTO workflow_agents (agent_id,run_id,session_id,agent_type,description) VALUES(?,?,?,?,?)').run(fi.agentId, fi.workflowRunId, fi.sessionId, meta.agentType||null, meta.description||null);
  } else {
    db.prepare('INSERT OR REPLACE INTO subagents VALUES(?,?,?,?,?,?,?)').run(fi.agentId, fi.sessionId, meta.toolUseId||null, meta.agentType||null, meta.description||null, dur, tok?.t||0);
  }
  return true;
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
        let wf;
        try {
          wf = JSON.parse(fs.readFileSync(path.join(wd, f), 'utf8'));
        } catch (error) {
          console.warn(`Warning: failed to read workflow ${f}: ${(error as Error).message}`);
          continue;
        }
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
      }
    }
  }
}

function indexHistory(db, { historyPath = DEFAULT_HISTORY_PATH } = {}) {
  if (!fs.existsSync(historyPath)) return;
  readLines(historyPath, (line) => {
    let item;
    try {
      item = JSON.parse(line);
    } catch (error) {
      console.warn(`Warning: malformed history line: ${(error as Error).message}`);
      return;
    }
    if (item.sessionId && item.title) db.prepare('UPDATE sessions SET title=? WHERE id=? AND title IS NULL').run(item.title, item.sessionId);
  });
}

function rebuildFts(db) {
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
}

// PASSIVE by default: it checkpoints what it can without blocking concurrent
// readers/writers, so it is safe to run after every build. A blocking TRUNCATE
// (which reclaims the -wal file but needs exclusive access and can contend with
// the daemon + queries) is reserved for maintenance/exit — pass mode explicitly.
function checkpointDb(db, mode = 'PASSIVE') {
  try {
    db.pragma(`wal_checkpoint(${mode})`);
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

function writeHeartbeat({
  dbPath = DEFAULT_DB_PATH,
  writerLeasePath = writerLockPathFor(dbPath),
  DatabaseImpl = Database,
  LockDatabaseImpl = DatabaseImpl,
} = {}) {
  if (!fs.existsSync(dbPath)) return;
  const lease = acquireWriterLease({
    lockPath: writerLeasePath,
    openDb: lockPath => new LockDatabaseImpl(lockPath),
  });
  if (!lease) return false;
  try {
    const db = new DatabaseImpl(dbPath);
    configureConnection(db, { busyTimeoutMs: 0 });
    const txDb = betterSqliteTransactionAdapter(db);
    try {
      runWriteTransaction(txDb, () => writeIndexMarker(db, '__app_heartbeat__'), { label: 'heartbeat' });
      return true;
    } finally {
      db.close();
    }
  } finally {
    lease.release();
  }
}

interface BuildIndexOptions {
  claudeDir?: string;
  codexDir?: string;
  projectsDir?: string;
  historyPath?: string;
  dbPath?: string;
  schemaPath?: string;
  DatabaseImpl?: new (dbPath: string) => any;
  LockDatabaseImpl?: new (dbPath: string) => any;
  force?: boolean;
  changedPaths?: string[];
  preserveDbPath?: string | null;
  writerLeasePath?: string;
  writerLeaseWaitMs?: number;
  writerLeaseMode?: 'acquire' | 'caller-held';
}

interface SkippedFile {
  path: string;
  error: string;
  diagnostics?: unknown;
}

interface BuildIndexResult {
  files: number;
  latestSourceMtime: number;
  affectedSessionIds: string[];
  ftsRebuilt: boolean;
  skipped: number;
  skippedFiles: SkippedFile[];
  deferred: boolean;
  reason?: string;
}

function deferredBuildResult(
  reason: string,
  overrides: Partial<Omit<BuildIndexResult, 'deferred' | 'reason'>> = {},
): BuildIndexResult {
  return {
    files: 0,
    latestSourceMtime: 0,
    affectedSessionIds: [],
    ftsRebuilt: false,
    skipped: 0,
    skippedFiles: [],
    ...overrides,
    deferred: true,
    reason,
  };
}

function buildIndex({
  claudeDir = DEFAULT_CLAUDE_DIR,
  codexDir = path.join(path.dirname(claudeDir), '.codex'),
  projectsDir = path.join(claudeDir, 'projects'),
  historyPath = path.join(claudeDir, 'history.jsonl'),
  dbPath = DEFAULT_DB_PATH,
  schemaPath = resolveSchemaPath(),
  DatabaseImpl = Database,
  LockDatabaseImpl = DatabaseImpl,
  force = false,
  changedPaths = undefined,
  preserveDbPath = null,
  writerLeasePath = writerLockPathFor(dbPath),
  writerLeaseWaitMs = 2000,
  writerLeaseMode = 'acquire',
}: BuildIndexOptions = {}): BuildIndexResult {
  if (writerLeaseMode !== 'acquire' && writerLeaseMode !== 'caller-held') {
    throw new Error(`Unknown writer lease mode: ${writerLeaseMode}`);
  }
  let lease: ReturnType<typeof acquireWriterLease> = null;
  if (writerLeaseMode === 'acquire') {
    lease = acquireWriterLease({
      lockPath: writerLeasePath,
      openDb: lockPath => new LockDatabaseImpl(lockPath),
      waitMs: writerLeaseWaitMs,
    });
    if (!lease) {
      return deferredBuildResult('writer_busy');
    }
  }
  try {
    const db = openIndexDb({ dbPath, schemaPath, DatabaseImpl });
    const txDb = betterSqliteTransactionAdapter(db);
    let messageFtsTriggersDropped = false;
    try {
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
          runRetryableWriteTransaction(txDb, () => {
            dropMessageFtsTriggers(db);
            db.prepare("DELETE FROM index_state WHERE substr(jsonl_path, 1, 2) != '__'").run();
            db.prepare("DELETE FROM messages").run();
            db.prepare("DELETE FROM tool_calls").run();
            db.prepare("DELETE FROM tool_results").run();
            db.prepare("DELETE FROM sessions").run();
            db.prepare("DELETE FROM summaries").run();
            db.prepare("DELETE FROM subagents").run();
            db.prepare("DELETE FROM workflows").run();
            db.prepare("DELETE FROM workflow_agents").run();
          }, { label: 'force-cleanup' });
          messageFtsTriggersDropped = true;
        }
      } catch (error) {
        if (isBeginBusyFailure(error)) {
          return deferredBuildResult('database_busy', {
            files: files.length,
            latestSourceMtime,
          });
        }
        throw error;
      }
      const affectedSessionIds = new Set<string>();
      const finalizeAffectedSessionIds = new Set<string>();
      const changedMetaJsonlPaths = new Set<string>();
      if (Array.isArray(changedPaths)) {
        for (const changedPath of changedPaths) {
          const sessionId = sessionIdFromChangedPath(projectsDir, changedPath);
          const normalizedChangedPath = normalizeChangedPath(projectsDir, changedPath);
          const isMetaChange = normalizedChangedPath?.toLowerCase().endsWith('.meta.json');
          if (isMetaChange && normalizedChangedPath) {
            changedMetaJsonlPaths.add(
              normalizedChangedPath.slice(0, -'.meta.json'.length) + '.jsonl',
            );
          }
          // Transcript files report their session only after their own transaction
          // commits. Workflow changes are applied during finalize, so stage those
          // IDs until the finalize transaction commits. Meta files map back to their
          // transcript transaction and are reported only after that commit.
          if (sessionId && !changedPath.toLowerCase().endsWith('.jsonl') && !isMetaChange) {
            finalizeAffectedSessionIds.add(sessionId);
          }
        }
      }
      const skipped: SkippedFile[] = [];
      for (const file of files) {
        try {
          // The write is committed before affectedSessionIds is updated, so a
          // failed/rolled-back file never reports a phantom updated session.
          const indexed = runRetryableWriteTransaction(txDb, () => {
            const result = file.source === 'codex' ? indexCodexFile(db, file) : indexClaudeFile(db, file);
            const metaIndexed = file.source !== 'codex' && indexSubagentMeta(db, file);
            if (!result?.sessionId && metaIndexed && changedMetaJsonlPaths.has(file.path)) {
              return { sessionId: file.sessionId, path: file.path };
            }
            return result;
          }, { label: `file:${file.path}` });
          if (indexed?.sessionId) affectedSessionIds.add(indexed.sessionId);
        } catch (error) {
          if (isBeginBusyFailure(error)) {
            return deferredBuildResult('database_busy', {
              files: files.length,
              latestSourceMtime,
              affectedSessionIds: [...affectedSessionIds],
              skipped: skipped.length,
              skippedFiles: skipped,
            });
          }
          if (hasUnusableTransaction(error)) throw error;
          skipped.push({ path: file.path, error: (error as Error).message, diagnostics: (error as { obelisk?: unknown }).obelisk });
          console.warn(`Warning: failed to index ${file.path}: ${(error as Error).message}`);
        }
      }
      let ftsRebuilt = false;
      // Finalize is one transaction; a failure here fails the whole build (the
      // index would otherwise be left inconsistent).
      try {
        runRetryableWriteTransaction(txDb, () => {
          indexWorkflows(db, { projectsDir });
          refreshSessionProjectPaths(db);
          indexHistory(db, { historyPath });
          indexCodexSessionIndex(db, { codexDir });
          if (messageFtsTriggersDropped) installSchema(db, schemaPath);
          ftsRebuilt = ensureFtsReady(db, { force });
          writeIndexMarker(db, '__last_build__');
          writeIndexMarker(db, '__app_last_successful_build__');
          writeIndexMarker(db, '__indexer_owner_app__');
          if (latestSourceMtime) writeIndexMarker(db, '__last_source_mtime__', latestSourceMtime);
        }, { label: 'finalize' });
      } catch (error) {
        if (isBeginBusyFailure(error)) {
          return deferredBuildResult('database_busy', {
            files: files.length,
            latestSourceMtime,
            affectedSessionIds: [...affectedSessionIds],
            skipped: skipped.length,
            skippedFiles: skipped,
          });
        }
        throw error;
      }
      for (const sessionId of finalizeAffectedSessionIds) affectedSessionIds.add(sessionId);
      return {
        files: files.length,
        latestSourceMtime,
        affectedSessionIds: [...affectedSessionIds],
        ftsRebuilt,
        skipped: skipped.length,
        skippedFiles: skipped,
        deferred: false,
      };
    } finally {
      if (messageFtsTriggersDropped) {
        try {
          installSchema(db, schemaPath);
        } catch (error) {
          console.warn(`Warning: failed to restore message FTS triggers: ${(error as Error).message}`);
        }
      }
      checkpointDb(db);
      db.close();
    }
  } finally {
    lease?.release();
  }
}

export {
  buildIndex,
  writeHeartbeat,
  openIndexDb,
  discoverJsonlFiles,
  inferProjectPath,
};
