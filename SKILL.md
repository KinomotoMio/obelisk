---
name: obelisk
description: >
  Search and query past Claude Code session history.
  Reactive: when the user asks "how did I fix X", "what did we do last time", "find the session where", "上次怎么修的", "之前的session", "历史记录".
  Proactive: when the user references past work you lack context for, when you're about to modify a file with complex edit history, when the user says "继续之前的" or "continue where we left off", or when understanding prior decisions would improve your current response.
  Memory: when the user says "记住这个", "remember this", "写入记忆", "save this conclusion", or when you determine a retrieval result contains a conclusion worth persisting.
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
Query scripts are read-only: `remember()` is not available, and `sql()` only
accepts read-only SELECT/WITH queries.

## Query Routing

Before writing a query, classify the task. Progressive disclosure is useful, but
skipping the relevant reference usually costs extra query rounds.

- Read `references/schema.md` before raw `sql()` unless the needed table/column relationship is already explicit here. Do this before running the SQL, not after a missing-column error.
- Read `references/retrieval-semantics.md` before multi-step retrieval, scoped project/file/session searches, or synthesis/conclusion/history questions. It defines the query design frame.
- Read `references/query-patterns.md` when you need copyable query scripts: one-shot synthesis, learned detail passes, workflow trees, failure groups, file history, summaries, subagents, raw windows, or empty results.
- Read `references/pitfalls.md` after an error or when helper fields, FTS syntax, aliases, or row shapes are unclear.

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

Read-only SQL SELECT/WITH with `?` placeholders. Returns array rows.

Before writing non-trivial SQL, read `references/schema.md`. Common safe joins:

- `tool_calls` does not have timestamps. Join `messages m ON m.uuid = tc.message_uuid`.
- `tool_results` does not have timestamps. Join `messages m ON m.uuid = tr.message_uuid`.
- For project/session filters, join `sessions s ON s.id = <table>.session_id`.
- Prefer SQL-side `GROUP BY`, `COUNT`, `MAX`, `ORDER BY`, and `LIMIT` over hand-counting in the final answer.

Tables: `sessions`, `messages`, `tool_calls`, `tool_results`, `summaries`,
`memories`, `subagents`, `workflows`, `workflow_agents`, `messages_fts`.

## Structured Helpers

These helpers are convenience accessors over the same SQLite structure. They do
not replace `sql()`; use `sql()` when you need an exact aggregation or a join
the helper does not expose.

All list helpers accept a bounded `limit`. Many also accept:
`{ project, after, before, sessionId, sessions, branch }`. Check the schema or a
tiny sample before relying on less common filters.

- `overview(opts?)` -- compact orientation map. Returns current cwd/project if knowable, global project counts, and current-project recent sessions plus memory records. It is a map, not evidence.
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
- `memories(opts?)` -- recall memory layer, newest first. opts: `{ query, project, sessionId, sessions, after, before, branch, limit }`. `query` filters summary/path by terms. Returns registered memory records (id, path, summary, project, session_id, created_at). Read the file at `path` for full content.

## Retrieval Contract

Keep queries scoped, bounded, and structural.

- Scope First: classify the locator as scope, artifact, or semantic. Use the narrowest structural locator before FTS; empty scoped results are valid unless the user asks to broaden.
- Orient When Needed: use `overview()` when the current project or available scopes are unclear. It is a navigation map; confirm facts with `memories()`, `search()`, helpers, or `sql()`.
- Plan Before Probe: for conclusion, broad history, failure investigation, or file evolution, write a bounded retrieval script instead of spending turns on intermediate results.
- Structure Before Text: compute counts, joins, grouping, dedupe, and projection in SQL or JS; keep runtime JSON compact, ideally under 10k-12k chars for synthesis tasks.
- Evidence Before Conclusion: return compact evidence with stable IDs (`session_id`, `uuid`, `tool_call_id`, `run_id`, `agent_id`) and short snippets, then synthesize in the final answer.
- Persist Durable Conclusions: after answering, if retrieval produced a durable conclusion that future sessions are likely to reuse and `memories()` does not already cover it, explicitly offer to write a memory. Keep the offer brief. Do not write the markdown file or run `--remember` until the user approves.

If field, context, ordering, FTS, or helper semantics affect the query, read
`references/retrieval-semantics.md` before coding. If a query errors, read
`references/pitfalls.md` before retrying.

## Memory Layer

Obelisk has a persistent memory layer alongside raw session data. Every
retrieval queries both layers: `memories()` for prior conclusions, `search()`
and helpers for raw session evidence. Use memory as prior notes, not final
authority. If a memory record influences your answer, say naturally that it was
previously recorded, and compare it with raw session evidence when correctness
depends on it. Raw session data is the evidence layer, but one hit is not a
complete truth; query and cite it compactly.

**Recall:** query `memories({ query: 'topic terms', project: '...' })` to find
prior conclusions relevant to the current task. Like other list helpers,
passing a string is treated as `sessionId`, and passing a number is treated as
`limit`. Read the file at `path` for full content.

Good memory candidates include design decisions, project conventions, abandoned
alternatives, repeated failure causes, workflow patterns, and conclusions
synthesized across multiple raw evidence points. Do not propose memory for
one-off lookups, uncertain findings, or conclusions already covered by existing
memories.

**Writing memories:** after a retrieval produces a conclusion worth persisting,
propose writing a memory file. The user must approve. Flow:

1. Write a markdown file using the `Write` tool (user approves).
2. Register it via `remember()` in a narrow memory-registration script:

```js
return remember({
  path: '.obelisk/memories/design-decision-x.md',
  session_id: 'current-session-id',
  message_start: 'uuid-of-first-relevant-msg',
  message_end: 'uuid-of-last-relevant-msg',
  summary: 'Detailed summary: what was decided, why, what alternatives were considered, and what constraints drove the choice.'
})
```

Run the registration script with:

```bash
node $SKILL_DIR/scripts/runtime.mjs --remember /tmp/register-memory.mjs
```

`--remember` exposes only `remember()`. It does not expose `search()`, `sql()`,
`memories()`, or other retrieval helpers. If you need source IDs, find them
first with a normal `--query` script.

`remember()` validates that `path` already exists and points to a file. Relative
paths are resolved against the source session's `project_path` when
`session_id` is provided, then stored as normalized absolute paths. Prefer
project-relative paths such as `.obelisk/memories/...` plus `session_id`.

`summary` should be detailed enough that `memories()` results alone can judge
relevance without reading the file. Include the decision, the reasoning, and
the key constraints — not just a title.

The `message_start`/`message_end` range marks where in the conversation this
conclusion was drawn. Use it later to trace back to the original evidence.

Memory records survive index rebuilds. They are never auto-deleted.

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
