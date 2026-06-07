# Obelisk -- Schema and API Reference

Advanced reference for the obelisk database.
Read this when `search()`, `context()`, or `sql()` are not enough.

---

## 1. Database Schema

Database location: `~/.claude/obelisk.sqlite`

### sessions

One row per Claude Code session.

```sql
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,   -- session UUID (matches JSONL filename)
  title         TEXT,               -- AI-generated session title (may be NULL)
  project       TEXT,               -- project slug (hyphenated path, e.g. "Users-tomiya-Code-quiet-zero")
  project_path  TEXT,               -- reconstructed filesystem path (e.g. "/Users/tomiya/Code/quiet-zero")
  started_at    TEXT,               -- ISO 8601 timestamp of first message
  ended_at      TEXT,               -- ISO 8601 timestamp of last message
  git_branch    TEXT,               -- git branch active during session (if any)
  version       TEXT,               -- Claude Code version string
  message_count INTEGER DEFAULT 0,  -- total user + assistant messages
  jsonl_path    TEXT                -- absolute path to source JSONL file
);
```

### messages

Every user and assistant message. Core table for all queries.

```sql
CREATE TABLE messages (
  uuid          TEXT PRIMARY KEY,   -- message UUID
  session_id    TEXT,               -- FK -> sessions.id
  type          TEXT,               -- "user" or "assistant"
  parent_uuid   TEXT,               -- UUID of parent message (conversation tree)
  timestamp     TEXT,               -- ISO 8601
  role          TEXT,               -- "user" or "assistant" (from message payload)
  text          TEXT,               -- extracted text content (thinking + text blocks, truncated to 10k chars)
  model         TEXT,               -- model name (e.g. "claude-opus-4-6-20250529"), NULL for user messages
  is_sidechain  INTEGER DEFAULT 0,  -- 1 if this message is on a sidechain (retry/branch)
  agent_id      TEXT,               -- subagent or workflow agent UUID (NULL for main conversation)
  input_tokens  INTEGER,            -- token usage (assistant messages only)
  output_tokens INTEGER,            -- token usage (assistant messages only)
  cwd           TEXT,               -- working directory at message time (may differ from session project_path)
  skill         TEXT,               -- skill that generated this response (e.g. "obelisk"), NULL if none
  turn_duration_ms INTEGER          -- wall-clock duration of the turn ending at this message (from system turn_duration event)
);
```

Indexes: `idx_messages_session(session_id)`, `idx_messages_agent(agent_id)`, `idx_messages_ts(session_id, timestamp)`.

### messages_fts

FTS5 virtual table for full-text search over message text.

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  uuid UNINDEXED,        -- not searchable, carried for JOINs
  session_id UNINDEXED,  -- not searchable, carried for filtering
  text,                  -- the searchable column
  content=messages,      -- content-sync with messages table
  content_rowid=rowid
);
```

Queried via `MATCH` syntax. Rebuilt on each index pass.

### tool_calls

Every tool invocation by the assistant. One row per `tool_use` content block.

```sql
CREATE TABLE tool_calls (
  id            TEXT PRIMARY KEY,   -- tool_use ID (from API response)
  message_uuid  TEXT,               -- FK -> messages.uuid (the assistant message containing this call)
  session_id    TEXT,               -- FK -> sessions.id (denormalized for fast queries)
  name          TEXT,               -- tool name: "Read", "Edit", "Write", "Bash", "WebSearch", etc.
  input_json    TEXT,               -- JSON-serialized tool input (truncated to 10k chars)
  file_path     TEXT                -- extracted file_path for Read/Edit/Write/NotebookEdit (NULL otherwise)
);
```

Indexes: `idx_tc_session_name(session_id, name)`, `idx_tc_file(file_path)`.

### tool_results

The result returned for each tool call. Appears in the next user message.

```sql
CREATE TABLE tool_results (
  tool_use_id   TEXT PRIMARY KEY,   -- FK -> tool_calls.id
  message_uuid  TEXT,               -- FK -> messages.uuid (the user message carrying this result)
  session_id    TEXT,               -- FK -> sessions.id (denormalized)
  content       TEXT,               -- result text (truncated to 10k chars)
  file_path     TEXT,               -- file path from toolUseResult metadata (if any)
  is_error      INTEGER DEFAULT 0   -- 1 if the tool call returned an error (from API is_error field)
);
```

### subagents

Metadata for subagent spawns (non-workflow agents).

```sql
CREATE TABLE subagents (
  agent_id          TEXT PRIMARY KEY,   -- subagent UUID
  session_id        TEXT,               -- FK -> sessions.id (parent session)
  parent_tool_use_id TEXT,              -- tool_use ID that spawned this agent
  agent_type        TEXT,               -- e.g. "code-review", "research"
  description       TEXT,               -- task description given to the subagent
  duration_ms       INTEGER,            -- wall-clock duration (computed from message timestamps)
  total_tokens      INTEGER             -- sum of input_tokens + output_tokens across all agent messages
);
```

Index: `idx_sa_session(session_id)`.

### workflows

Workflow execution records. A workflow orchestrates multiple agents.

```sql
CREATE TABLE workflows (
  run_id        TEXT PRIMARY KEY,   -- workflow run UUID
  session_id    TEXT,               -- FK -> sessions.id (parent session)
  task_id       TEXT,               -- task identifier (if any)
  script        TEXT,               -- workflow script content (truncated)
  result_json   TEXT,               -- JSON-serialized workflow result
  timestamp     TEXT,               -- ISO 8601 execution time
  agent_count   INTEGER DEFAULT 0,  -- number of agents in this workflow
  duration_ms   INTEGER,            -- wall-clock duration of the workflow run
  total_tokens  INTEGER,            -- total tokens across all agents
  status        TEXT,               -- "completed", "failed", etc.
  workflow_name TEXT                 -- name from the workflow script meta
);
```

Index: `idx_wf_session(session_id)`.

### workflow_agents

Individual agents within a workflow run.

```sql
CREATE TABLE workflow_agents (
  agent_id      TEXT PRIMARY KEY,   -- agent UUID (prefixed with "agent-")
  run_id        TEXT,               -- FK -> workflows.run_id
  session_id    TEXT,               -- FK -> sessions.id
  agent_type    TEXT,               -- agent type label
  description   TEXT,               -- task description
  phase         TEXT,               -- workflow phase title (e.g. "Review", "Verify")
  label         TEXT,               -- agent label from workflow script
  model         TEXT,               -- model used (e.g. "claude-opus-4-6[1m]")
  state         TEXT,               -- "done", "error", etc.
  duration_ms   INTEGER,            -- wall-clock duration of this agent
  tokens        INTEGER,            -- total tokens used by this agent
  tool_calls    INTEGER             -- number of tool calls made
);
```

Index: `idx_wa_run(run_id)`.

### index_state

Tracks incremental indexing progress per JSONL file.

```sql
CREATE TABLE index_state (
  jsonl_path      TEXT PRIMARY KEY,   -- absolute path to JSONL file
  mtime           REAL,               -- file mtime at last index (milliseconds)
  lines_processed INTEGER             -- number of lines already processed
);
```

### Key Relationships

```
sessions.id        <--  messages.session_id
sessions.id        <--  tool_calls.session_id
sessions.id        <--  tool_results.session_id
sessions.id        <--  subagents.session_id
sessions.id        <--  workflows.session_id
messages.uuid      <--  tool_calls.message_uuid
messages.uuid      <--  tool_results.message_uuid
messages.agent_id  -->  subagents.agent_id      (for subagent messages)
messages.agent_id  -->  workflow_agents.agent_id (for workflow agent messages)
tool_calls.id      <--  tool_results.tool_use_id
workflows.run_id   <--  workflow_agents.run_id
```

---

## 2. Query API Reference

All functions are available as globals inside `--query` scripts.
Scripts run in an async IIFE with a 30-second timeout.

### Simple Layer

#### `search(text, opts?)`

Full-text search across all message text using FTS5.

| Param | Type | Description |
|-------|------|-------------|
| `text` | `string` | FTS5 query (terms, phrases, prefix) |
| `opts.limit` | `number` | Max results (default 20) |
| `opts.sessionId` | `string` | Restrict to one session |
| `opts.project` | `string` | SQL `LIKE` pattern over `sessions.project` |
| `opts.after` | `string` | ISO 8601 lower bound on timestamp |
| `opts.before` | `string` | ISO 8601 upper bound on timestamp |
| `opts.cwd` | `string` | Filter by working directory (supports LIKE) |

**Scope note:** `sessions.project` is the stored Claude Code project slug,
`sessions.project_path` is the reconstructed absolute project path, and
`messages.cwd` is the working directory at message time. Helper `project`
filters are fuzzy `LIKE` filters over `sessions.project`. For exact project
membership, use `sql()` with `s.project = ?` or `s.project_path = ?`.

**Returns:** `Array<{ message, session, rank, context }>` where `context` is the
6 nearest messages by timestamp in the same session. It is temporal neighbor
context, not a parent chain. `rank` is the FTS5 relevance score used by
`ORDER BY rank`; lower values sort earlier, so treat the returned order as the
relevance order unless you are deliberately using FTS5 ranking details.

```js
const hits = search('MCTS exploration');
return hits.map(h => ({ title: h.session.title, text: h.message.text?.slice(0, 200) }));
```

#### `context(uuid)`

Full context around a single message: parent chain, session metadata, subagent/workflow info.

| Param | Type | Description |
|-------|------|-------------|
| `uuid` | `string` | Message UUID |

**Returns:** `{ message, parentChain, session, subagent, workflow }` or `null`.

```js
const c = context('abc-123-def');
return { chain_length: c.parentChain.length, session_title: c.session?.title };
```

#### `sql(query, ...params)`

Raw SQL with parameterized bindings. Returns an array of row objects.

| Param | Type | Description |
|-------|------|-------------|
| `query` | `string` | SQL SELECT statement |
| `...params` | `any` | Bind parameters (positional `?`) |

**Returns:** `Array<Object>` -- each row as `{ column: value }`.

```js
const rows = sql('SELECT id, title FROM sessions WHERE project = ? ORDER BY ended_at DESC LIMIT 5', 'Users-tomiya-Code-quiet-zero');
return rows;
```

### Advanced Layer

#### `trace(uuid)`

Walk the `parent_uuid` chain from a message up to the conversation root.

**Returns:** `Array<message>` ordered root-first.

```js
const chain = trace('some-uuid');
return chain.map(m => ({ role: m.role, text: m.text?.slice(0, 100) }));
```

#### `thread(sessionId)`

All messages in a session, ordered by timestamp.

**Returns:** `Array<message>`.

```js
const msgs = thread('session-uuid');
return { count: msgs.length, first: msgs[0]?.text?.slice(0, 100) };
```

#### `subagents(opts?)`

All subagent spawns, with message counts. For backward compatibility, passing a string is treated as `sessionId`.

| Param | Type | Description |
|-------|------|-------------|
| `opts.sessionId` | `string` | Restrict to one session |
| `opts.project` | `string` | SQL `LIKE` pattern over `sessions.project` |
| `opts.limit` | `number` | Max results (default 100) |

**Returns:** `Array<{ ...subagent_row, messageCount }>`.

```js
const subs = subagents({ project: '%quiet-zero%' });
return subs.map(s => ({ type: s.agent_type, desc: s.description, msgs: s.messageCount, tokens: s.total_tokens }));
```

#### `workflows(opts?)`

Workflow executions. For backward compatibility, passing a string is treated as `sessionId`.

| Param | Type | Description |
|-------|------|-------------|
| `opts.sessionId` | `string` | Restrict to one session |
| `opts.project` | `string` | SQL `LIKE` pattern over `sessions.project` |
| `opts.after` | `string` | ISO 8601 lower bound on timestamp |
| `opts.before` | `string` | ISO 8601 upper bound on timestamp |
| `opts.limit` | `number` | Max results (default 100) |

**Returns:** `Array<workflow_row>`.

```js
const wfs = workflows({ project: '%quiet-zero%' });
return wfs.map(w => ({ run: w.run_id, agents: w.agent_count, time: w.timestamp }));
```

#### `workflowTree(runId)`

Lightweight execution tree for a workflow: metadata, parsed result, and agent summaries with phase/label/performance data. Does not load agent messages — use `sql()` with `agent_id` to drill into a specific agent.

**Returns:** `{ ...workflow_row, result: object, agents: Array<{ ...agent_row, messageCount }> }` or `null`.

```js
const tree = workflowTree('run-uuid');
return tree?.agents.map(a => ({ phase: a.phase, label: a.label, tokens: a.tokens, msgs: a.messageCount }));
```

#### `fileHistory(filePath, opts?)`

All tool calls that touched a specific file, across every session.

| Param | Type | Description |
|-------|------|-------------|
| `filePath` | `string` | Absolute file path (required) |
| `opts.after` | `string` | ISO 8601 lower bound |
| `opts.before` | `string` | ISO 8601 upper bound |
| `opts.limit` | `number` | Max results (default 200) |

**Returns:** `Array<{ toolCall, session, timestamp }>`.

Default order is oldest first (`ORDER BY m.timestamp`). For recent file changes,
use raw SQL with `ORDER BY m.timestamp DESC`.

```js
const edits = fileHistory('/Users/tomiya/Code/quiet-zero/src/mcts.ts', { after: '2026-05-28' });
return edits.map(e => ({ tool: e.toolCall.name, session: e.session.title, time: e.timestamp }));
```

#### `failures(opts?)`

Tool calls whose results contain error patterns (`Error`, `ENOENT`, `failed`, `permission denied`, etc.). Includes the 3 messages immediately after each failure for retry context. For backward compatibility, passing a string is treated as `sessionId`.

| Param | Type | Description |
|-------|------|-------------|
| `opts.sessionId` | `string` | Restrict to one session |
| `opts.project` | `string` | SQL `LIKE` pattern over `sessions.project` |
| `opts.after` | `string` | ISO 8601 lower bound |
| `opts.before` | `string` | ISO 8601 upper bound |
| `opts.limit` | `number` | Max results (default 50) |

**Returns:** `Array<{ toolCall, result, session, nextMessages }>`.

Default order is newest first by the result message timestamp.

```js
const fails = failures({ project: '%quiet-zero%', limit: 10 });
return fails.map(f => ({ tool: f.toolCall?.name, error: f.result.content?.slice(0, 200) }));
```

#### `recent(n?)`

Shorthand for `sessions({ limit: n })`. Last `n` sessions (default 10), ordered by `ended_at` descending.

**Returns:** `Array<session_row>`.

```js
const last5 = recent(5);
return last5.map(s => ({ title: s.title, project: s.project_path, ended: s.ended_at }));
```

#### `sessions(opts?)`

Query sessions with filters. For backward compatibility, passing a number is treated as `limit`.

| Param | Type | Description |
|-------|------|-------------|
| `opts.project` | `string` | SQL `LIKE` pattern over `sessions.project` |
| `opts.after` | `string` | ISO 8601 lower bound on `started_at` |
| `opts.before` | `string` | ISO 8601 upper bound on `started_at` |
| `opts.limit` | `number` | Max results (default 50) |
| `opts.branch` | `string` | Filter by git branch (exact match) |
| `opts.sessionId` | `string` | Restrict to one session |
| `opts.sessions` | `string[]` | Restrict to a set of session IDs |

**Returns:** `Array<session_row>` ordered by `ended_at` descending.

For exact slug/path membership, use raw SQL with `project = ?` or
`project_path = ?`.

```js
const qz = sessions({ project: '%quiet-zero%', limit: 5 });
return qz.map(s => ({ title: s.title, branch: s.git_branch, ended: s.ended_at }));
```

---

## 3. Common Query Patterns

### Find sessions about a topic

```js
const hits = search('reinforcement learning');
const sessions = [...new Set(hits.map(h => h.session.id))];
return hits.slice(0, 10).map(h => ({
  session: h.session.title,
  snippet: h.message.text?.slice(0, 150),
}));
```

### Trace a decision chain

```js
// Find a message, then trace its full parent chain to understand how we got there
const hits = search('"switched to PPO"');
if (!hits.length) return 'not found';
const chain = trace(hits[0].message.uuid);
return chain.map(m => ({ role: m.role, text: m.text?.slice(0, 120), ts: m.timestamp }));
```

### Find all edits to a file across sessions

```js
const edits = fileHistory('/Users/tomiya/Code/quiet-zero/src/mcts.ts');
return edits.map(e => ({
  action: e.toolCall.name,
  session: e.session.title,
  time: e.timestamp,
}));
```

### Find churned files (most-edited across all sessions)

```js
const rows = sql(`
  SELECT file_path, COUNT(*) as edit_count, COUNT(DISTINCT session_id) as session_count
  FROM tool_calls
  WHERE file_path IS NOT NULL AND name IN ('Edit','Write')
  GROUP BY file_path
  ORDER BY edit_count DESC
  LIMIT 20
`);
return rows;
```

### Token usage analysis

```js
const rows = sql(`
  SELECT s.id, s.title,
    SUM(m.input_tokens) as total_in,
    SUM(m.output_tokens) as total_out,
    SUM(m.input_tokens) + SUM(m.output_tokens) as total
  FROM messages m JOIN sessions s ON s.id = m.session_id
  WHERE m.input_tokens IS NOT NULL
  GROUP BY s.id
  ORDER BY total DESC
  LIMIT 10
`);
return rows;
```

### Find workflow results

```js
const wfs = workflows();
for (const wf of wfs.slice(0, 3)) {
  const tree = workflowTree(wf.run_id);
  wf.agent_details = tree?.agents.map(a => ({
    type: a.agent_type, desc: a.description, msgs: a.messages.length,
  }));
}
return wfs.slice(0, 3);
```

### Find error patterns

```js
const fails = failures();
// Group by tool name
const byTool = {};
for (const f of fails) {
  const name = f.toolCall?.name || 'unknown';
  byTool[name] = (byTool[name] || 0) + 1;
}
return { total: fails.length, byTool };
```

### Find what tools were used most

```js
const rows = sql(`
  SELECT name, COUNT(*) as call_count, COUNT(DISTINCT session_id) as session_count
  FROM tool_calls
  GROUP BY name
  ORDER BY call_count DESC
`);
return rows;
```

### Find sessions by time range

```js
return sessions({ after: '2026-05-28T00:00:00Z', before: '2026-05-30T00:00:00Z' }).map(s => ({
  title: s.title, project: s.project_path, started: s.started_at, messages: s.message_count,
}));
```

### Cross-reference subagent findings

```js
// See what all subagents did in a session
const subs = subagents('session-uuid');
const details = subs.map(s => {
  const msgs = sql('SELECT text, role FROM messages WHERE agent_id = ? ORDER BY timestamp', s.agent_id);
  return { type: s.agent_type, desc: s.description, summary: msgs.slice(-1)[0]?.text?.slice(0, 300) };
});
return details;
```

### Find all sessions for a project

```js
return sessions({ project: '%quiet-zero%' }).map(s => ({
  title: s.title, started: s.started_at, ended: s.ended_at,
  messages: s.message_count, branch: s.git_branch,
}));
```

### Reconstruct what happened in a session

```js
// Full timeline: messages + tool calls interleaved
const msgs = thread('session-uuid');
return msgs.map(m => {
  const tools = sql('SELECT name, file_path FROM tool_calls WHERE message_uuid = ?', m.uuid);
  return {
    role: m.role, text: m.text?.slice(0, 100), ts: m.timestamp,
    tools: tools.length ? tools.map(t => `${t.name}(${t.file_path || ''})`) : undefined,
  };
});
```

---

## 4. Tips

### When to use `search()` vs `sql()`

- **`search()`** -- when you are looking for messages containing specific words or phrases.
  Uses FTS5 under the hood, returns ranked results with surrounding context.
  Best for: "find where we discussed X", "when did I mention Y".
- **`sql()`** -- when you need structured queries: aggregations, JOINs, GROUP BY, date ranges,
  or anything involving tables other than `messages`.
  Best for: "how many edits to this file", "total tokens this week", "most-used tools".

### FTS5 Match Syntax

The `text` argument to `search()` uses SQLite FTS5 query syntax:

| Pattern | Meaning | Example |
|---------|---------|---------|
| `word` | Match token | `search('MCTS')` |
| `word1 word2` | Implicit AND | `search('MCTS exploration')` |
| `"exact phrase"` | Phrase match | `search('"Monte Carlo tree"')` |
| `word*` | Prefix match | `search('optim*')` matches optimize, optimizer, optimization |
| `word1 OR word2` | Either term | `search('PPO OR TRPO')` |
| `word1 NOT word2` | Exclude | `search('MCTS NOT debug')` |

Terms are case-insensitive. FTS5 tokenizes on whitespace and punctuation,
so `camelCase` is indexed as two tokens (`camel`, `case`).

### Performance

- **FTS5 searches** are fast (milliseconds) regardless of database size.
- **`sql()` with indexes** is fast. The indexed columns cover the common patterns:
  `messages(session_id)`, `messages(agent_id)`, `messages(session_id, timestamp)`,
  `tool_calls(session_id, name)`, `tool_calls(file_path)`.
- **JOINs across large sessions** (1000+ messages) can be slow if you join
  `messages` with `tool_calls` and `tool_results` without filtering by `session_id` first.
  Always add a `session_id` filter when working within a session.
- **Full table scans on `tool_results`** (used by `failures()` with no session ID)
  can be slow on large databases because it pattern-matches every result row.
  Pass a `sessionId` when possible.
- **Text fields are truncated** to 10,000 characters at index time. If you need
  the full content of a long message or tool result, read the source JSONL directly
  (path available in `sessions.jsonl_path`).
- The database uses **WAL mode** and **NORMAL synchronous**, so reads never block
  writes during re-indexing.
