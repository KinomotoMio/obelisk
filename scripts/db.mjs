import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
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
  input_tokens INTEGER, output_tokens INTEGER,
  cwd TEXT, skill TEXT, turn_duration_ms INTEGER);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY, message_uuid TEXT, session_id TEXT,
  name TEXT, input_json TEXT, file_path TEXT);
CREATE TABLE IF NOT EXISTS tool_results (
  tool_use_id TEXT PRIMARY KEY, message_uuid TEXT, session_id TEXT,
  content TEXT, file_path TEXT, is_error INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS subagents (
  agent_id TEXT PRIMARY KEY, session_id TEXT, parent_tool_use_id TEXT,
  agent_type TEXT, description TEXT, duration_ms INTEGER, total_tokens INTEGER);
CREATE TABLE IF NOT EXISTS workflows (
  run_id TEXT PRIMARY KEY, session_id TEXT, task_id TEXT,
  script TEXT, result_json TEXT, timestamp TEXT, agent_count INTEGER DEFAULT 0,
  duration_ms INTEGER, total_tokens INTEGER, status TEXT, workflow_name TEXT);
CREATE TABLE IF NOT EXISTS workflow_agents (
  agent_id TEXT PRIMARY KEY, run_id TEXT, session_id TEXT,
  agent_type TEXT, description TEXT,
  phase TEXT, label TEXT, model TEXT, state TEXT,
  duration_ms INTEGER, tokens INTEGER, tool_calls INTEGER);
CREATE TABLE IF NOT EXISTS index_state (
  jsonl_path TEXT PRIMARY KEY, mtime REAL, lines_processed INTEGER);
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY, session_id TEXT, timestamp TEXT,
  source TEXT, content TEXT);
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
CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
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

export { CLAUDE_DIR, DB_PATH, TEXT_LIMIT, openDb, trunc, truncJson, extractText, filePath, isDir, readLines, fs, path, os };
