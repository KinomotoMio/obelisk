# Obelisk Query Patterns

These are copyable CodeAct patterns for `runtime.mjs --query` scripts. They are
not new APIs. Adapt them to the user's scope and return compact evidence.

## Bounded Search To Context

Use `search()` to locate candidates, then expand only the strongest hits.

```js
const hits = search('"runtime query"', { project: '%quiet-zero%', limit: 8 });
return hits.slice(0, 5).map(h => {
  const c = context(h.message.uuid);
  return {
    session_id: h.session.id,
    session_title: h.session.title,
    uuid: h.message.uuid,
    timestamp: h.message.timestamp,
    snippet: h.message.text?.slice(0, 240),
    parentChain: (c?.parentChain || []).slice(-3).map(m => ({
      uuid: m.uuid,
      role: m.role,
      snippet: m.text?.slice(0, 120),
    })),
  };
});
```

## Facet Sweep For Broad History

Use this only for broad synthesis questions such as "how did X evolve", "what
did we do on X", or "what problems happened". Do not use it for concept recall,
exact session lookup, exact term recall, or tasks that ask for compact search
hits.

Keep the sweep small: 3-4 facets, `limit: 3` per facet, and at most 12 compact
evidence rows.

```js
const name = 'obelisk';
const facets = [
  'runtime CLI script',
  'schema SQLite FTS',
  'skill API helper docs',
  'test failure problem',
];

const rows = [];
for (const facet of facets) {
  for (const h of search(`${name} ${facet}`, { project: '%quiet-zero%', limit: 3 })) {
    rows.push({ facet, h });
  }
}

const seen = new Set();
return rows
  .filter(({ h }) => {
    const key = h.message.uuid || `${h.session.id}:${h.message.timestamp}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })
  .slice(0, 12)
  .map(({ facet, h }) => ({
    facet,
    session_id: h.session.id,
    session_title: h.session.title,
    project: h.session.project,
    uuid: h.message.uuid,
    timestamp: h.message.timestamp,
    snippet: h.message.text?.slice(0, 180),
  }));
```

## Summary Rows And Neighbors

Use `source`, `content`, `session_id`, `project`, and `session_title`.

```js
const rows = summaries({ project: '%quiet-zero%', limit: 8 });
return rows.map(s => ({
  id: s.id,
  session_id: s.session_id,
  session_title: s.session_title,
  project: s.project,
  source: s.source,
  timestamp: s.timestamp,
  snippet: s.content?.slice(0, 240),
}));
```

To inspect messages around one summary:

```js
const s = summaries({ project: '%quiet-zero%', limit: 1 })[0];
if (!s) return { results: [] };
const before = sql(
  `SELECT uuid, role, timestamp, substr(text,1,200) AS snippet
   FROM messages
   WHERE session_id=? AND timestamp<?
   ORDER BY timestamp DESC LIMIT 3`,
  s.session_id,
  s.timestamp
);
const after = sql(
  `SELECT uuid, role, timestamp, substr(text,1,200) AS snippet
   FROM messages
   WHERE session_id=? AND timestamp>?
   ORDER BY timestamp ASC LIMIT 3`,
  s.session_id,
  s.timestamp
);
return { summary: s, before, after };
```

## File History Synthesis

`fileHistory()` contains reads as well as writes. For "why/how did this file
change", scan a bounded `Edit`/`Write` set first, then return only compact
evidence. Do not choose the answer from only the first few rows if the question
asks for evolution.

```js
const rows = fileHistory('/absolute/path/to/file', { limit: 100 });
const writes = rows.filter(r => ['Edit', 'Write'].includes(r.toolCall?.name));
const reads = rows.filter(r => r.toolCall?.name === 'Read');

const bySession = new Map();
for (const r of writes) {
  const sid = r.session.id;
  const group = bySession.get(sid) || {
    session_id: sid,
    session_title: r.session.title,
    project: r.session.project,
    write_edit_count: 0,
    first_timestamp: r.timestamp,
    last_timestamp: r.timestamp,
    themes: [],
    evidence: [],
  };
  group.write_edit_count++;
  group.first_timestamp = group.first_timestamp < r.timestamp ? group.first_timestamp : r.timestamp;
  group.last_timestamp = group.last_timestamp > r.timestamp ? group.last_timestamp : r.timestamp;
  const snippet = String(r.toolCall.input_json || '').slice(0, 360);
  if (group.themes.length < 8) group.themes.push(snippet);
  if (group.evidence.length < 3) {
    group.evidence.push({
      tool: r.toolCall.name,
      tool_id: r.toolCall.id,
      timestamp: r.timestamp,
      snippet,
    });
  }
  bySession.set(sid, group);
}

return {
  counts: { reads: reads.length, writes_edits: writes.length },
  sessions: [...bySession.values()].slice(0, 10),
};
```

## Failed Tool Counts

For precise counts, aggregate in SQL. Do not hand-count long result rows in the
final answer.

```js
const counts = sql(`
  SELECT
    tc.name AS tool_name,
    COUNT(*) AS failure_count,
    MAX(m.timestamp) AS last_failure_at
  FROM tool_results tr
  JOIN tool_calls tc ON tc.id = tr.tool_use_id
  JOIN messages m ON m.uuid = tr.message_uuid
  JOIN sessions s ON s.id = tr.session_id
  WHERE tr.is_error = 1
    AND s.project LIKE ?
  GROUP BY tc.name
  ORDER BY failure_count DESC, last_failure_at DESC
  LIMIT 20
`, '%quiet-zero%');

const examples = sql(`
  SELECT
    tr.tool_use_id,
    tc.name AS tool_name,
    m.timestamp,
    s.id AS session_id,
    s.title AS session_title,
    substr(tr.content, 1, 180) AS error_snippet
  FROM tool_results tr
  JOIN tool_calls tc ON tc.id = tr.tool_use_id
  JOIN messages m ON m.uuid = tr.message_uuid
  JOIN sessions s ON s.id = tr.session_id
  WHERE tr.is_error = 1
    AND s.project LIKE ?
  ORDER BY m.timestamp DESC
  LIMIT 8
`, '%quiet-zero%');

return { counts, examples };
```

## Failure Investigation Groups

For questions like "recent failed tool calls", "which tasks failed", or "group
failures by task/session", group structurally and return sparse examples. Use
SQL for counts; treat `failures()` as an evidence helper, not a precise counter.

```js
const project = '%quiet-zero%';

const groups = sql(`
  SELECT
    s.id AS session_id,
    s.title AS session_title,
    s.project,
    COUNT(*) AS failure_count,
    MAX(m.timestamp) AS last_failure_at
  FROM tool_results tr
  JOIN tool_calls tc ON tc.id = tr.tool_use_id
  JOIN messages m ON m.uuid = tr.message_uuid
  JOIN sessions s ON s.id = tr.session_id
  WHERE tr.is_error = 1
    AND s.project LIKE ?
  GROUP BY s.id
  ORDER BY last_failure_at DESC
  LIMIT 10
`, project);

const examples = sql(`
  SELECT
    tr.tool_use_id AS tool_call_id,
    tc.name AS tool_name,
    s.id AS session_id,
    m.timestamp,
    substr(tr.content, 1, 180) AS error_snippet
  FROM tool_results tr
  JOIN tool_calls tc ON tc.id = tr.tool_use_id
  JOIN messages m ON m.uuid = tr.message_uuid
  JOIN sessions s ON s.id = tr.session_id
  WHERE tr.is_error = 1
    AND s.project LIKE ?
  ORDER BY m.timestamp DESC
  LIMIT 12
`, project);

return { groups, examples };
```

## Workflow Tree Compact View

Find the run with `workflows()` under scope, then project `workflowTree()` into
compact fields. Do not return raw `script`, `result_json`, or the full tree.

```js
const runs = workflows({ project: '%quiet-zero%', limit: 30 });
const target = runs.find(w =>
  /session[-_ ]journal/i.test(`${w.workflow_name || ''} ${w.task_id || ''} ${w.run_id || ''}`)
);
if (!target) {
  return {
    found: false,
    candidates: runs.slice(0, 8).map(w => ({
      run_id: w.run_id,
      workflow_name: w.workflow_name,
      timestamp: w.timestamp,
      agent_count: w.agent_count,
    })),
  };
}

const tree = workflowTree(target.run_id);
return {
  run_id: target.run_id,
  workflow_name: target.workflow_name,
  status: tree?.status ?? target.status,
  timestamp: tree?.timestamp ?? target.timestamp,
  agent_count: tree?.agent_count ?? tree?.agents?.length ?? target.agent_count,
  agents: (tree?.agents || []).map(a => ({
    agent_id: a.agent_id,
    phase: a.phase,
    label: a.label,
    state: a.state,
    tokens: a.tokens,
    messageCount: a.messageCount,
  })),
};
```

## Subagent Metadata Recall

Use `subagents()` for metadata. Do not expand transcripts unless the user asks.

```js
const rows = subagents({ project: '%quiet-zero%', limit: 50 });
return rows
  .filter(r => /obelisk/i.test(`${r.description || ''} ${r.agent_type || ''}`))
  .map(r => ({
    agent_id: r.agent_id,
    agent_type: r.agent_type,
    description: r.description,
    session_id: r.session_id,
    messageCount: r.messageCount,
    total_tokens: r.total_tokens,
  }));
```

## Empty Result Without Fallback

If the user asks for an exact sentinel, scoped project, or exact file, an empty
result is valid. Report it; do not broaden automatically.

```js
const needle = 'obelisk-impossible-sentinel-20260602';
const hits = search(`"${needle.replace(/-/g, ' ')}"`, { limit: 10 });
const real = hits.filter(h => {
  const scope = `${h.session?.project || ''} ${h.message?.cwd || ''}`;
  return !/SkillOpt[-/. ]outputs|obelisk_train|obelisk-eval/i.test(scope);
});
return real.map(h => ({
  session_id: h.session.id,
  session_title: h.session.title,
  project: h.session.project,
  uuid: h.message.uuid,
  snippet: h.message.text?.slice(0, 200),
}));
```

## Raw Window

Use `raw()` only after identifying a specific message UUID.

```js
const row = sql(`
  SELECT uuid, length(text) AS indexed_len
  FROM messages
  WHERE length(text) >= 10000
  LIMIT 1
`)[0];
if (!row) return null;
const first = raw(row.uuid, { offset: 0, limit: 4000 });
return {
  uuid: row.uuid,
  indexed_len: row.indexed_len,
  totalLength: first?.totalLength,
  hasMore: first?.hasMore,
  text: first?.text?.slice(0, 500),
};
```
