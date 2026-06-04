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

Searches and queries your Claude Code session history stored in `~/.claude/`.
A SQLite index with FTS5 full-text search covers all sessions, subagent conversations, and workflow agent runs.
You write JS query snippets that run in a sandboxed VM against the indexed data, then parse the JSON output.

## Quick Start

The base directory for this skill is provided as `$SKILL_DIR` at invocation time (shown as "Base directory for this skill: ...").

**Fast keyword search** (no script needed):

```bash
node $SKILL_DIR/scripts/runtime.mjs --search "keyword"
```

**Custom query** (write a JS snippet, run it):

1. Write a query to a temp file (e.g. `/tmp/q.mjs`)
2. Run: `node $SKILL_DIR/scripts/runtime.mjs --query /tmp/q.mjs`
3. Parse the JSON stdout and answer the user

The query file body is executed inside `(async () => { ... })()` with the API below available as globals. The last expression is returned as JSON. Use `return` to emit results.

## API

### search(text, opts?)

Full-text search across all messages (user, assistant, subagent, workflow agent).

Returns: `[{ message: {uuid, text, role, timestamp, model, cwd}, session: {id, title, project, started_at}, rank, context: [...surrounding messages] }]`

opts: `{ limit, sessionId, project, after, before, cwd }`

`rank` is the FTS5 relevance score (negative; closer to 0 = more relevant). Use it to judge result quality and stop early when results become irrelevant.

### sessions(opts?)

Query sessions with filters. Returns session rows ordered by `ended_at` descending.

opts: `{ project, after, before, limit, branch, sessionId, sessions }`

```js
sessions({ project: '%quiet-zero%' })
sessions({ after: '2026-06-01', branch: 'main', limit: 5 })
```

### context(uuid)

Full story around a message: the message itself, parent chain, session info, subagent/workflow metadata.

Returns: `{ message, parentChain, session, subagent, workflow }`

### recent(n?)

Shorthand for `sessions({ limit: n })`. Latest n sessions (default 10).

### sql(query, ...params)

Raw SQL. Use `?` placeholders. Returns array of row objects.

**Before writing your first SQL query, read `references/schema.md` for the full table schema, column names, and relationships.** Don't guess column names — the schema is your source of truth.

**Schema-safe SQL pattern:** when aggregating event tables, join to the table that actually owns the metadata instead of inventing columns. For example, `tool_calls` does **not** own timestamps; join `messages m ON m.uuid = tc.message_uuid` for `m.timestamp`, and join `sessions s ON s.id = tc.session_id` for project/session filters. Prefer SQL-side `GROUP BY`/`COUNT`/`MAX` with `LIMIT`, and return compact evidence rows with stable IDs rather than raw event records.

Tables: `sessions`, `messages`, `tool_calls`, `tool_results`, `subagents`, `workflows`, `workflow_agents`, `messages_fts`

### Other APIs

All list-returning functions accept a common filter opts object: `{ project, after, before, limit, sessionId, sessions }`. For backward compatibility, passing a string is treated as `sessionId`, a number as `limit`.

- `trace(uuid)` -- full parent chain from root to message
- `thread(sessionId)` -- all messages in a session, ordered by time
- `subagents(opts?)` -- subagent metadata + message counts. opts: `{ sessionId, project, limit }`
- `workflows(opts?)` -- workflow runs with duration, tokens, status. opts: `{ sessionId, project, after, before, limit }`
- `workflowTree(runId)` -- workflow metadata + parsed result + agents with phase/label/tokens/duration (no messages; use `sql()` with `agent_id` to drill into a specific agent)
- `fileHistory(filePath, opts?)` -- every Edit/Write/Read on a file. opts: `{ after, before, limit }`
- `failures(opts?)` -- tool calls that returned errors, with surrounding context. opts: `{ sessionId, project, after, before, limit }`
- `summaries(opts?)` -- session summaries (away recaps, compaction summaries). opts: `{ sessionId, project, after, before, limit, sessions }`. Returns: `[{ id, session_id, timestamp, source, content, session_title, project }]`. Use `source` for values like `away_summary`; use `content` for the summary text.
- `raw(uuid, opts?)` -- windowed access to the original JSONL line (bypasses index truncation)

### Retrieval strategy

**For helper field/schema confirmation questions:** use the relevant helper under the user's explicit scope with a small `limit`, then return only `Object.keys(row)` or a projection of the fields being verified plus short snippets. Do not invent alias fields when helper docs/rows use different names (for summaries, use `source`, `content`, `session_id`, `project`; not `text` or `summary_type`). Include stable evidence IDs such as `id`, `session_id`, or `uuid` in the final answer.

**Respect explicit scopes and empty results.** If the user asks for a specific project/session/file/time range, keep every query inside that scope. When a scoped helper call such as `summaries({ project, limit })` returns `[]`, report no results; do not broaden to all projects or all summaries unless the user asks for fallback.

**Never pull an entire session.** Navigate incrementally:

1. `sessions({ project: '...' })` or `recent()` — find relevant sessions
2. `summaries({ project: '...' })` — read session summaries to judge relevance (cheapest)
3. `search()` — find specific messages matching a query
4. When you find a relevant message and want more context, expand from that point:
   - **Horizontally**: use `sql()` to fetch neighboring messages by timestamp
     ```js
     sql('SELECT uuid,role,text FROM messages WHERE session_id=? AND timestamp>? ORDER BY timestamp LIMIT 5', sid, msg.timestamp)
     ```
   - **Vertically**: use `trace(uuid)` to walk up the parent chain, or `context(uuid)` to see subagent/workflow relationships
4. `raw(uuid, opts?)` — recover truncated content from a specific message
5. `thread(sessionId)` — full session dump, **last resort only**

**File history queries:** `fileHistory()` can include many `Read` rows and large tool inputs. For questions about how a file changed, filter to `Edit`/`Write` before returning, cap the filtered list to the requested evidence count, and return compact evidence records only.

### raw(uuid, opts?)

Some indexed fields (tool call inputs, tool results) are truncated to 10k chars. `raw()` reads the original JSONL line to recover the full content.

Returns: `{ text, totalLength, offset, limit, hasMore }`

opts: `{ offset: 0, limit: 10000 }` — character window into the raw JSONL line.

```js
// First window
const r = raw(messageUuid)
// r.text = first 10k chars of the original JSONL line
// r.totalLength = full line length
// r.hasMore = true if more content remains

// Scroll forward
const r2 = raw(messageUuid, { offset: 10000, limit: 10000 })
```

## Examples

### "上次怎么修 auth 的"

```js
const hits = search('auth fix')
return hits.slice(0, 5).map(h => ({
  session: h.session.title,
  date: h.session.started_at,
  message: h.message.text?.slice(0, 200)
}))
```

### "最近在做什么"

```js
return sessions({ limit: 10 }).map(s => ({ title: s.title, project: s.project, date: s.started_at }))
```

### "哪些文件被反复修改"

```js
return sql(`
  SELECT file_path, COUNT(*) as n FROM tool_calls
  WHERE name IN ('Edit','Write') AND file_path IS NOT NULL
  GROUP BY file_path HAVING n > 3 ORDER BY n DESC LIMIT 20
`)
```

### "这个项目的 workflow 跑过几次"

```js
return workflows({ project: '%quiet-zero%' }).map(w => ({
  run: w.run_id, agents: w.agent_count, time: w.timestamp
}))
```

### "上次跑 experiment 用了多少 token"

```js
const hits = search('experiment')
if (!hits.length) return 'No experiment sessions found'
const sid = hits[0].session.id
return sql('SELECT SUM(input_tokens) as input, SUM(output_tokens) as output FROM messages WHERE session_id = ?', sid)
```

### "追踪一下那个决策是怎么做的"

```js
const hits = search('the decision query here')
if (!hits.length) return 'Nothing found'
return context(hits[0].message.uuid)
```

## Notes

- First run builds the index (~5s for ~100 sessions). Subsequent runs are incremental.
- DB location: `~/.claude/obelisk.sqlite`
- Subagent and workflow agent conversations are fully indexed and searchable.
- Query scripts run in a sandboxed VM context -- no file system or network access from inside scripts.
- Text is truncated to 10k chars per message during indexing.
- FTS5 search supports standard SQLite FTS syntax: `"exact phrase"`, `term1 AND term2`, `term1 OR term2`, `term1 NOT term2`.
- FTS5 tokenizes on hyphens. To search for `SkillOpt-outputs`, use `"skillopt outputs"` (replace hyphen with space, wrap in quotes for phrase match). For exact match on hyphenated strings, use `sql()` with LIKE instead.
