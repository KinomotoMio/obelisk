import { createRequire } from 'node:module';
import { CLAUDE_DIR, CODEX_DIR, TEXT_LIMIT, trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, filePath, isDir, readLines } from './parsing.mjs';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const OBELISK_DIR = path.join(os.homedir(), '.obelisk');
const LEGACY_DB_PATH = path.join(CLAUDE_DIR, 'obelisk.sqlite');
const DB_PATH = path.join(OBELISK_DIR, 'obelisk.sqlite');
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


export { CLAUDE_DIR, CODEX_DIR, OBELISK_DIR, DB_PATH, TEXT_LIMIT, openDb, rebuildMemoryFts, trunc, truncJson, extractText, extractContentType, extractMessageIsMeta, filePath, isDir, readLines, fs, path, os };
