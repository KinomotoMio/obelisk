# Obelisk Retrieval Semantics

Read this before designing a non-trivial query. This is the query design frame;
`pitfalls.md` is only the debug checklist.

## Four Principles

### Scope First

Classify the user's request before choosing tools.

| User signal | Locator mode | Start with | Avoid first |
|-------------|--------------|------------|-------------|
| unclear project/session landscape | orientation | `overview()` | treating overview rows as evidence |
| project name/path, session, cwd, file, time range | scope | `sessions()`, exact SQL on `project_path`, `sessionId`, `fileHistory()` | broad FTS |
| workflow, subagent, tool call, summary, edit | artifact | `workflows()`, `subagents()`, `summaries()`, `tool_calls`, `tool_results` | all-session search |
| concept, conclusion, design history, vague memory | semantic | `memories({ query })`, `search()`, summaries, bounded facet sweep | session dumps |

`overview()` is a navigation map: current cwd/project if knowable, global
project counts, and recent current-project session/memory entry points. Use it
when scope is unclear, then query the memory or raw session layer for evidence.
It does not guess the current session.

One-shot retrieval is not all-shot retrieval. A query script may perform
multiple steps, but the first locator should be the narrowest semantic fit. If a
scope locator finds the relevant project/session/file, do not also run broad FTS
unless scoped evidence is insufficient and `query_plan` says why.

Project-like fields are distinct:

- `sessions.project`: stored Claude Code project slug.
- `memories.project`: stored project slug copied onto registered memory records.
- `sessions.project_path`: absolute session path derived from message `cwd` when available; slug decoding is only a fallback.
- `messages.cwd`: working directory at message time.
- helper `project`: SQL `LIKE` over `sessions.project`, not exact membership.

For exact project membership, use `sql()` with `s.project = ?` or
`s.project_path = ?`. Empty or tiny scoped results are valid results; do not
broaden unless the user asks or your `query_plan` explicitly marks a fallback.

### Plan Before Probe

For conclusion, broad history, failure investigation, or file evolution tasks,
prefer a retrieval script over interactive probing.

Good shape:

1. locate candidates with scope/artifact/semantic locators;
2. expand only selected hits;
3. dedupe and group in the script;
4. return compact evidence rows plus counts and limits.

If a second detail pass is needed, derive filters or facets from the first pass:
candidate sessions, discovered vocabulary, files, tools, timestamps, or
decisions. Prefer a learned faceted detail pass over `LIMIT 25` session windows.
If vocabulary is still unclear, use a small filtered window and say so in
`query_plan`.

### Structure Before Text

Use the database shape before asking the model to read text.

- Count and aggregate in SQL or JS (`GROUP BY`, `COUNT`, `MAX`, `ORDER BY`, `LIMIT`).
- Join metadata from the owner table instead of inventing fields.
- Project compact rows; do not return whole sessions, complete workflow trees, full raw messages, or entire tool results.
- Keep synthesis runtime JSON around 10k-12k chars when possible.
- For recent failures, aggregate by session/task and return sparse examples.
- For file evolution, filter `fileHistory()` to `Edit`/`Write`, group by session or phase, and return short deltas.

Ordering and context are semantic:

- `sessions()`, `memories()`, `summaries()`, `workflows()`, and `failures()` are newest first.
- `fileHistory()` is oldest first.
- `search().context` is temporal neighbors in one session, not causal context.
- `context(uuid)` and `trace(uuid)` are for parent-chain/causal expansion.

### Evidence Before Conclusion

Obelisk's raw session layer stores original structure, not precompiled claims:
sessions, messages, summaries, tool calls/results, files, subagents, workflows,
parent chains, and raw JSONL windows. The memory layer can store
human-approved markdown conclusions, but treat them as prior notes to compare
against raw evidence when correctness matters.

For semantic questions, build a task-local evidence view:

```js
{
  query_plan: { mode, scope, facets, limits },
  prior_memories: [
    { id, path, session_id, created_at, summary }
  ],
  evidence: [
    { type, id, session_id, timestamp, facet, snippet }
  ],
  omitted: 0
}
```

Then synthesize the conclusion in the final answer. Do not pretend the raw
evidence view is itself a stored Obelisk entity.

After synthesis, check whether the conclusion should become a memory. Offer to
write one when the result is durable, likely to help future sessions, and not
already covered by `prior_memories`. Good candidates include design decisions,
project conventions, abandoned alternatives, repeated failure causes, workflow
patterns, and conclusions synthesized across multiple raw evidence points. Do
not propose memory for one-off lookups, uncertain findings, or duplicate
coverage. The offer is only a proposal: write the markdown file and run
`--remember` only after user approval.

## Text Search Semantics

`search(text)` passes text to SQLite FTS5 `MATCH`.

- Hyphens tokenize: for `workflow-script`, use `"workflow script"` or SQL `LIKE` for literal punctuation.
- Special characters may produce FTS syntax errors; simplify or quote the FTS query under the same scope.
- Exact phrase, token search, and literal punctuation are different semantics.
- Results are ordered by `ORDER BY rank`; lower rank sorts earlier. Prefer returned order over "closer to zero" comparisons.
