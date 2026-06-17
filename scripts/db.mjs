import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CODEX_DIR = path.join(os.homedir(), '.codex');
const OBELISK_DIR = path.join(os.homedir(), '.obelisk');
const LEGACY_DB_PATH = path.join(CLAUDE_DIR, 'obelisk.sqlite');
const DB_PATH = path.join(OBELISK_DIR, 'obelisk.sqlite');
const TEXT_LIMIT = 10000;
const SCHEMA = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

function migrateLegacyDbIfNeeded() {
  if (fs.existsSync(DB_PATH)) return;
  if (!fs.existsSync(LEGACY_DB_PATH)) return;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.copyFileSync(LEGACY_DB_PATH, DB_PATH);
}

function openDb() {
  migrateLegacyDbIfNeeded();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  migrateExistingColumns(db);
  db.exec(SCHEMA);
  migrateDb(db);
  return db;
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function migrateExistingColumns(db) {
  if (tableExists(db, 'sessions')) ensureColumn(db, 'sessions', 'source', "TEXT DEFAULT 'claude'");
  if (tableExists(db, 'messages')) {
    ensureColumn(db, 'messages', 'content_type', 'TEXT');
    ensureColumn(db, 'messages', 'is_meta', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'messages', 'source', "TEXT DEFAULT 'claude'");
  }
  if (tableExists(db, 'memories')) {
    ensureColumn(db, 'memories', 'anchors', 'TEXT');
    ensureColumn(db, 'memories', 'deleted_at', 'TEXT');
    ensureColumn(db, 'memories', 'deleted_reason', 'TEXT');
  }
}

function migrateDb(db) {
  migrateExistingColumns(db);
}

function rebuildMemoryFts(db) {
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
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

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function readLines(filePath, callback) {
  const fd = fs.openSync(filePath, 'r');
  const bufSize = 64 * 1024;
  const buf = Buffer.alloc(bufSize);
  let remainder = '';
  let bytesRead;
  try {
    while ((bytesRead = fs.readSync(fd, buf, 0, bufSize)) > 0) {
      const chunk = remainder + buf.toString('utf8', 0, bytesRead);
      const lines = chunk.split('\n');
      remainder = lines.pop();
      for (const line of lines) {
        if (line && callback(line) === false) return;
      }
    }
    if (remainder) callback(remainder);
  } finally {
    fs.closeSync(fd);
  }
}

export { CLAUDE_DIR, CODEX_DIR, OBELISK_DIR, DB_PATH, TEXT_LIMIT, openDb, rebuildMemoryFts, trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, filePath, isDir, readLines, fs, path, os };
