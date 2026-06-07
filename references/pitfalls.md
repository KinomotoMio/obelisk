# Obelisk Pitfalls

Use this when a query may over-fetch, when a scoped query returns few or zero
rows, or when helper fields are unclear.

## Scope Is A Contract

If the user gives a project, session, file, or time range, keep every query
inside that scope. Do not broaden because a scoped result is small.

There are three different project-like scopes:

- `sessions.project`: stored Claude Code project slug.
- `sessions.project_path`: reconstructed absolute project path.
- `messages.cwd`: working directory for a specific message.

`project` filters in helpers are SQL `LIKE` patterns over `sessions.project`.
`%quiet-zero%` can match benchmark or generated workspaces that merely contain
that string. Prefer exact `sql()` filters when the user asks for exact project
membership:

```js
sql(`
  SELECT id, title, project, project_path, ended_at
  FROM sessions
  WHERE project_path = ?
  ORDER BY ended_at DESC
  LIMIT 20
`, '/Users/tomiya/Code/quiet-zero')
```

Use fuzzy project search only when the task is discovery or the user explicitly
asked to search broadly. If you broaden, make the broadening visible in the
returned evidence.

Self-noise examples to filter when the user asks for real historical sessions:

- `SkillOpt-outputs`
- `obelisk_train`
- `obelisk-eval`

## FTS5 Hyphens And Syntax

`search(text)` passes text to FTS5 `MATCH`. Hyphenated terms can be parsed as
operators or separate tokens, and special characters can raise FTS syntax
errors.

For `workflow-script`, use a quoted tokenized phrase:

```js
search('"workflow script"', { limit: 10 })
```

Use exact phrases for phrase semantics, separate terms for token semantics, and
SQL `LIKE` for literal punctuation. Do not silently fallback from a scoped FTS
query to all sessions.

For exact hyphen matching, use SQL `LIKE` on `messages.text` under a scope:

```js
sql(`
  SELECT m.uuid, s.id AS session_id, s.title, substr(m.text,1,240) AS snippet
  FROM messages m
  JOIN sessions s ON s.id = m.session_id
  WHERE s.project LIKE ?
    AND m.text LIKE ?
  ORDER BY m.timestamp DESC
  LIMIT 10
`, '%quiet-zero%', '%workflow-script%')
```

`rank` is already applied by `ORDER BY rank`; lower rank sorts earlier in this
runtime. Prefer returned order over comparing "closer to zero" manually.

## Context Is Not Always Causal

`search().context` returns temporal neighbors: nearby messages by timestamp in
the same session. It is useful for quick orientation, but it is not the parent
chain and may cross side branches, subagents, or workflow boundaries.

Use:

- `context(uuid)` for message, parent chain, session, subagent, and workflow.
- `trace(uuid)` for just the parent chain.
- SQL timestamp neighbors for horizontal expansion inside one session.

## Ordering Defaults Matter

Some helpers return newest first; others do not.

- `sessions()` returns newest sessions first.
- `summaries()` returns newest summaries first.
- `workflows()` returns newest workflows first.
- `failures()` returns newest failures first, but should still be treated as an evidence helper rather than a precise count helper.
- `fileHistory()` orders by message timestamp ascending. If the user asks for recent changes, use SQL explicitly:

```js
sql(`
  SELECT tc.id, tc.name, tc.file_path, m.timestamp, s.id AS session_id, s.title
  FROM tool_calls tc
  JOIN messages m ON m.uuid = tc.message_uuid
  JOIN sessions s ON s.id = tc.session_id
  WHERE tc.file_path = ?
    AND tc.name IN ('Edit', 'Write', 'NotebookEdit')
  ORDER BY m.timestamp DESC
  LIMIT 20
`, '/absolute/path/to/file')
```

## Compact Vs Raw

Default to compact evidence. Raw/full access is a conscious escalation.

- `workflowTree()` may include `script`, `result_json`, parsed `result`, and all agents. Project only the fields needed for the answer.
- `thread(sessionId)` dumps a whole session; use it only as a last resort.
- `raw(uuid)` can recover long original JSONL lines; use small windows and cite `totalLength`/`hasMore`.
- Tool results and tool inputs can be large. Return short snippets.

## Field Names To Avoid Guessing

Common wrong guesses:

- Summaries: use `source` and `content`; do not use `summary_type` or `text`.
- Tool result timestamps: `tool_results` has no timestamp. Join `messages`.
- Tool call timestamps: `tool_calls` has no timestamp. Join `messages`.
- Workflow agent message counts: `workflowTree()` returns `messageCount` for agents.

When uncertain:

```js
const rows = summaries({ limit: 1 });
return rows.length ? Object.keys(rows[0]) : [];
```

## Counting Must Be Structural

If the user asks "how many", "counts", "top N", or "group by", compute it in SQL
or in the query script and return the computed data. Do not infer counts from
visible snippets in prose.

Good:

```js
sql(`
  SELECT tc.name, COUNT(*) AS n
  FROM tool_results tr
  JOIN tool_calls tc ON tc.id = tr.tool_use_id
  WHERE tr.is_error = 1
  GROUP BY tc.name
  ORDER BY n DESC
  LIMIT 10
`)
```

Bad:

```js
const rows = failures({ limit: 20 });
return rows; // then count by eye in the final answer
```

## Empty Results

An empty array is often the correct answer.

When the user asks for a scoped project/file/session or an exact sentinel:

1. Run the scoped query.
2. Return `[]` or compact counts.
3. Say no matching prior result was found.
4. Do not call `recent()`, all-project `summaries()`, or `thread()` as fallback unless the user asks.
