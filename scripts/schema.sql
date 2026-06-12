CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, title TEXT, project TEXT, project_path TEXT,
  started_at TEXT, ended_at TEXT, git_branch TEXT, version TEXT,
  message_count INTEGER DEFAULT 0, jsonl_path TEXT);
CREATE TABLE IF NOT EXISTS messages (
  uuid TEXT PRIMARY KEY, session_id TEXT, type TEXT, parent_uuid TEXT,
  timestamp TEXT, role TEXT, text TEXT, content_type TEXT,
  is_meta INTEGER DEFAULT 0, model TEXT,
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
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, session_id TEXT, project TEXT,
  message_start TEXT, message_end TEXT,
  path TEXT, anchors TEXT, summary TEXT, created_at TEXT,
  deleted_at TEXT, deleted_reason TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED, path, summary,
  content=memories, content_rowid=rowid,
  tokenize='unicode61 remove_diacritics 1');
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
