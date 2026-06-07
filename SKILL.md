---
name: obelisk
description: >
  Search and query past Claude Code session history.
  Reactive: when the user asks "how did I fix X", "what did we do last time", "find the session where", "上次怎么修的", "之前的session", "历史记录".
  Proactive: when the user references past work you lack context for, when you're about to modify a file with complex edit history, when the user says "继续之前的" or "continue where we left off", or when understanding prior decisions would improve your current response.
allowed-tools:
  - Read
  - Bash(node:*)
  - Write
---

# obelisk

Search and query Claude Code session history stored in `~/.claude/`.
Obelisk indexes sessions, messages, tool calls, tool results, summaries,
subagents, workflows, workflow agents, parent chains, and raw JSONL lines into
SQLite + FTS5.

Obelisk is a CodeAct memory layer: write a small JS query, run it locally, read
the JSON, then answer. Do not turn history into a flat document or browse entire
sessions by default.

## Quick Start

The skill directory is provided as `$SKILL_DIR` at invocation time.

Fast keyword search:

```bash
node $SKILL_DIR/scripts/runtime.mjs --search "keyword"
```

Custom query:

1. Write a bounded JS query to a temp file, for example `/tmp/q.mjs`.
2. Run:

   ```bash
   node $SKILL_DIR/scripts/runtime.mjs --query /tmp/q.mjs
   ```

3. Parse JSON stdout and answer with concise evidence.

The query file runs inside `(async () => { ... })()`. Use `return` to emit JSON.

## Reference Triggers

Use progressive disclosure, but do not guess.

- Read `references/schema.md` before raw `sql()` unless the needed table/column relationship is already explicit here.
- Read `references/query-patterns.md` for one-shot synthesis retrieval, workflow trees, failed tool counts or failure groups, broad development-history synthesis, file history synthesis, summary neighbors, subagent recall, raw windows, and empty-result handling.
- Read `references/pitfalls.md` when a scoped result is empty or tiny, when a query may over-fetch, when a term is hyphenated, when project scope is ambiguous, or when helper row fields are unclear.

If a helper row shape is unclear, first run a tiny scoped query and return
`Object.keys(row)` or a compact sample. Do not invent field names.

## Core API

### `search(text, opts?)`

Full-text search across main messages, subagent messages, and workflow-agent
messages.

Returns:

```js
[{ message: { uuid, text, role, timestamp, model, cwd },
   session: { id, title, project, started_at },
   rank,
   context }]
```

`context` here means temporal neighbors: nearby messages in the same session by
timestamp. It is not the parent chain. Use `context(uuid)` or `trace(uuid)` for
causal/parent-chain context.

Opts: `{ limit, sessionId, project, after, before, cwd }`.

`project` is a SQL `LIKE` filter over `sessions.project`, not an exact project
identity. Results are already ordered by FTS5 rank; lower rank sorts earlier.
Prefer returned order over manually interpreting numeric rank unless you are
deliberately using FTS5 semantics.

### `context(uuid)`

Returns the full story around one indexed message:

```js
{ message, parentChain, session, subagent, workflow }
```

Use this after `search()` finds a promising message. It is the usual way to
expand vertically from one evidence point without dumping the whole session.

### `sql(query, ...params)`

Raw SQL with `?` placeholders. Returns array rows.

Before writing non-trivial SQL, read `references/schema.md`. Common safe joins:

- `tool_calls` does not have timestamps. Join `messages m ON m.uuid = tc.message_uuid`.
- `tool_results` does not have timestamps. Join `messages m ON m.uuid = tr.message_uuid`.
- For project/session filters, join `sessions s ON s.id = <table>.session_id`.
- Prefer SQL-side `GROUP BY`, `COUNT`, `MAX`, `ORDER BY`, and `LIMIT` over hand-counting in the final answer.

Tables: `sessions`, `messages`, `tool_calls`, `tool_results`, `summaries`,
`subagents`, `workflows`, `workflow_agents`, `messages_fts`.

## Structured Helpers

These helpers are convenience accessors over the same SQLite structure. They do
not replace `sql()`; use `sql()` when you need an exact aggregation or a join
the helper does not expose.

All list helpers accept a bounded `limit`. Many also accept:
`{ project, after, before, sessionId, sessions, branch }`. Check the schema or a
tiny sample before relying on less common filters.

- `sessions(opts?)` -- session rows, newest first. `project` is a SQL `LIKE` pattern.
- `recent(n?)` -- shorthand for recent sessions.
- `summaries(opts?)` -- summary rows, newest first: `{ id, session_id, timestamp, source, content, session_title, project }`.
- `subagents(opts?)` -- subagent metadata plus `messageCount`.
- `workflows(opts?)` -- workflow runs, newest first.
- `workflowTree(runId)` -- workflow row plus parsed `result` and `agents`; may include bulky `script` and `result_json`, so project compact fields.
- `fileHistory(filePath, opts?)` -- Read/Edit/Write tool calls for a file, oldest first; includes many `Read` rows.
- `failures(opts?)` -- failed tool results with tool/session context, newest first.
- `trace(uuid)` -- parent chain from root to message.
- `thread(sessionId)` -- full session messages; last resort only.
- `raw(uuid, opts?)` -- windowed access to the original JSONL line.

## Retrieval Contract

Keep queries scoped, bounded, and structural.

- Preserve explicit project/session/file/time scopes. Empty or tiny scoped results are real results; do not broaden unless the user asks.
- Treat project scope as three distinct semantics: exact `sessions.project` slug, exact `sessions.project_path`, or fuzzy `LIKE` search. Use `sql()` for exact slug/path membership; helper `project` means fuzzy `LIKE`.
- Start with cheap locators: `sessions()`, `summaries()`, `search()`, or a small SQL query.
- Expand incrementally with `context()`, `trace()`, neighbor SQL, or `raw()` windows.
- For conclusion, broad history, failure investigation, or file evolution questions, prefer one bounded query script that locates, expands, dedupes, groups, and returns compact evidence rows. Do not spend multiple conversation turns showing intermediate query results.
- Return compact evidence with stable IDs (`session_id`, `uuid`, `tool_call_id`, `run_id`, `agent_id`) and short snippets.
- Avoid `thread()` unless the user explicitly asks for a full transcript or all smaller probes are insufficient.
- Keep runtime JSON small. Do not return all sessions, all summaries, all tool calls, complete workflow trees, full raw messages, or whole tool results.
- When counting or aggregating, compute counts in SQL or in the query script and return those counts. Do not hand-count from long rows in prose.
- For recent failures or "which tasks failed" questions, aggregate by session/task and return counts plus sparse examples. Do not return raw failure rows.
- For broad "how did X evolve / what did we do / what problems happened" history synthesis, use a bounded facet sweep from `references/query-patterns.md`. For concept recall, session lookup, or exact term recall, keep compact `search()` first.

High-frequency field contracts:

- `summaries()` uses `source` and `content`, not `summary_type` or `text`.
- `search().context` is temporal neighbor context, not causal or parent-chain context.
- `fileHistory()` includes `Read`; filter to `Edit`/`Write` for causal change history.
- `workflowTree()` may expose raw `script` and `result_json`; omit them unless the user asks for raw workflow details.
- `fileHistory()` is ordered oldest first. For recent file changes, use SQL with `ORDER BY m.timestamp DESC`.
- FTS5 tokenizes hyphens and treats `search(text)` as raw `MATCH` syntax. For `workflow-script`, search the quoted tokenized phrase such as `"workflow script"` or use SQL `LIKE` for exact hyphen matching.

## Minimal Patterns

Search, then expand one promising hit:

```js
const hits = search('auth fix', { limit: 5 });
if (!hits.length) return [];
return hits.slice(0, 3).map(h => ({
  session_id: h.session.id,
  session_title: h.session.title,
  uuid: h.message.uuid,
  snippet: h.message.text?.slice(0, 240),
}));
```

Check helper fields before assuming names:

```js
const rows = summaries({ project: '%quiet-zero%', limit: 1 });
return rows.length ? Object.keys(rows[0]) : [];
```

Fetch message neighbors without a full thread:

```js
const hit = search('runtime query', { limit: 1 })[0];
return sql(
  `SELECT uuid, role, timestamp, substr(text,1,240) AS snippet
   FROM messages
   WHERE session_id=? AND timestamp>=?
   ORDER BY timestamp LIMIT 6`,
  hit.session.id,
  hit.message.timestamp
);
```

See `references/query-patterns.md` for longer recipes.

## Notes

- First run builds the index. Later runs update incrementally.
- DB location: `~/.claude/obelisk.sqlite`.
- Query scripts run in a sandboxed VM with no filesystem or network access from inside the script.
- Indexed text and stored tool inputs/results are truncated to 10k chars. Use `raw(uuid, { offset, limit })` for specific JSONL windows.
