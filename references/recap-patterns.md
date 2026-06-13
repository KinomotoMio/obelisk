# Obelisk Recap Patterns

Use this when Obelisk Intent Routing sends the `recap` intent. In practice,
that means the first word after `/obelisk` is `recap`; everything after it is
the recap target.

Do not self-trigger this reference from broad weekly/monthly summaries, charts,
rankings, shareable-card language, or playlist-style metaphors. Those are target
details only after the explicit `recap` intent has already selected this file.

This is an optional app handoff pattern. Obelisk stays agent-first: the agent
queries sessions and memories, judges what matters, then fills card content.
The app owns rendering, layout, export, and animation.

## Common Period Targets

Treat the target after `recap` as normal user language. Common app-generated
targets:

- `/obelisk recap this week` -- the current calendar week in the user's timezone.
- `/obelisk recap last week` -- the previous calendar week.
- `/obelisk recap this month` -- the current calendar month.
- `/obelisk recap last month` -- the previous calendar month.

Use the current date and timezone from the runtime/session context when
available. If the target contains extra style language, keep the period meaning
and treat the rest as presentation guidance.

## Contract

- Produce card content, not HTML, CSS, SVG, or layout instructions.
- Keep the first result share-safe. Avoid secrets, tokens, private URLs, long
  absolute paths, raw tool outputs, and embarrassing private text unless the
  user asked for private analysis.
- Concrete numbers, exact times, quotes, and verdicts need evidence. If you
  cannot support a detail, omit it or soften it.
- Memory is prior notes, not ground truth. If a card uses a memory conclusion,
  say in prose that it came from a prior memory when answering in chat, and add
  `memory_id` evidence when producing JSON.
- Do not propose a durable memory just because you generated a recap. Propose
  memory only if the retrieval reveals a reusable cross-session conclusion not
  already covered by `memories()`.

## Retrieval Shape

Start with orientation and bounded evidence. Use English memory queries even
when the recap text will be in another language.

```js
const period = {
  label: 'Week 24',
  after: '2026-06-08T00:00:00+08:00',
  before: '2026-06-15T00:00:00+08:00',
  timezone: 'Asia/Shanghai',
};

const map = overview({ limit: 8 });
const project = map.current.project?.project;
const scoped = project ? { project } : {};

return {
  current: map.current,
  current_project: map.current_project,
  prior_memories: memories({
    ...scoped,
    query: 'weekly recap project decisions workflows debugging shipping',
    limit: 8,
  }).map(m => ({
    id: m.id,
    path: m.path,
    anchors: m.anchors,
    session_id: m.session_id,
    created_at: m.created_at,
    summary: m.summary?.slice(0, 280),
  })),
  sessions: sessions({
    ...scoped,
    after: period.after,
    before: period.before,
    limit: 40,
  }).map(s => ({
    id: s.id,
    title: s.title,
    project: s.project,
    branch: s.git_branch,
    started_at: s.started_at,
    ended_at: s.ended_at,
    message_count: s.message_count,
  })),
  summaries: summaries({
    ...scoped,
    after: period.after,
    before: period.before,
    limit: 30,
  }).map(s => ({
    id: s.id,
    session_id: s.session_id,
    session_title: s.session_title,
    project: s.project,
    timestamp: s.timestamp,
    snippet: s.content?.slice(0, 260),
  })),
  workflows: workflows({
    ...scoped,
    after: period.after,
    before: period.before,
    limit: 20,
  }).map(w => ({
    run_id: w.run_id,
    session_id: w.session_id,
    name: w.workflow_name,
    status: w.status,
    agent_count: w.agent_count,
    tokens: w.total_tokens,
    timestamp: w.timestamp,
  })),
  failures: failures({
    ...scoped,
    after: period.after,
    before: period.before,
    limit: 12,
  }).map(f => ({
    session_id: f.session_id,
    session_title: f.session_title,
    tool: f.tool_name,
    timestamp: f.timestamp,
    snippet: f.content?.slice(0, 180),
  })),
};
```

Use SQL for exact aggregate numbers after the helper-first pass has established
the scope. Keep meta rows out of ordinary user-visible counts.

```js
const project = '%quiet-zero%';
const after = '2026-06-08T00:00:00+08:00';
const before = '2026-06-15T00:00:00+08:00';

const metrics = sql(`
  SELECT
    COUNT(DISTINCT s.id) AS sessions,
    COUNT(m.uuid) AS messages,
    COALESCE(SUM(COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0)), 0) AS tokens,
    COUNT(DISTINCT substr(m.timestamp, 1, 10)) AS active_days
  FROM sessions s
  LEFT JOIN messages m ON m.session_id = s.id
  WHERE s.project LIKE ?
    AND COALESCE(m.is_meta, 0) = 0
    AND m.timestamp >= ?
    AND m.timestamp < ?
`, project, after, before)[0];

const user_messages = sql(`
  SELECT
    m.uuid,
    m.session_id,
    s.title AS session_title,
    m.timestamp,
    substr(m.text, 1, 500) AS text
  FROM messages m
  JOIN sessions s ON s.id = m.session_id
  WHERE s.project LIKE ?
    AND m.type = 'user'
    AND m.content_type = 'text'
    AND COALESCE(m.is_meta, 0) = 0
    AND m.timestamp >= ?
    AND m.timestamp < ?
  ORDER BY m.timestamp
  LIMIT 300
`, project, after, before);

return { metrics, user_messages };
```

## Archetypes

Choose one dominant archetype from the evidence. Do not force all cards to match
it; the archetype is the cover persona and tone baseline.

| archetype | essential action | tone baseline |
|---|---|---|
| `architect` | establishes structure, boundaries, and systems from above | matter-of-fact, structural pride |
| `debugger` | loops through symptoms until root cause becomes visible | wry, weary, occasional dark humor |
| `shipper` | keeps pushing forward with dense cadence | energetic, slightly breathless |
| `curator` | collects, organizes, refines, and distills | reflective, low-key clarity |
| `director` | coordinates many threads from the center outward | observant, slight remove |
| `cartographer` | reorganizes known structure, redraws maps, moves boundaries | patient, surveyor-like |
| `wanderer` | crosses projects without one obvious center, leaving traces | gentle, accepting, no apology |

Selection hints:

- Use `architect` when the week is dominated by system design, APIs, schemas,
  boundaries, or core concepts.
- Use `debugger` when repeated failures, false positives, regressions, or root
  cause hunts dominate.
- Use `shipper` when the evidence shows sustained implementation velocity,
  builds, releases, or many completed edits.
- Use `curator` when the work is mostly cleanup, documentation, memory,
  organization, or taste/refinement.
- Use `director` when workflows, subagents, review loops, or multi-agent
  coordination are the main story.
- Use `cartographer` when the user moves modules, redraws information
  architecture, re-scopes boundaries, or turns "this lives here" into "this
  belongs there".
- Use `wanderer` when the period spans many unrelated projects and the honest
  story is exploratory rather than centered.

## JSON Shape

The schema is deliberately card-content oriented. Keep keys stable, but let
strings carry the style. Card text can use the user's language; field names stay
English.

For weekly recaps, `metrics.active_days` and cover `activity` should contain 7
numbers ordered Monday through Sunday, where `0` means no visible activity and
`1` means active. For monthly recaps, use one value per calendar day in the
period, or omit the field if the evidence is too thin.

```ts
type Recap = {
  schema_version: "obelisk.recap.v1";
  kind: "weekly" | "monthly";
  generated_at: string;

  period: {
    label: string;
    start: string;
    end: string;
    timezone: string;
  };

  source: {
    project?: string;
    session_ids: string[];
    memory_ids?: string[];
  };

  metrics: {
    sessions?: number;
    messages?: number;
    tokens?: number;
    active_days?: number[];
    streak_days?: number;
    workflows?: number;
    workflow_agents?: number;
    corrections?: number;
  };

  persona: {
    archetype:
      | "architect"
      | "debugger"
      | "shipper"
      | "curator"
      | "director"
      | "cartographer"
      | "wanderer";
    title: string;
    subtitle: string;
    tone: string;
  };

  cards: [
    CoverCard,
    ThinkingPathCard,
    VibeCard,
    WorkflowOrToolsCard,
    ClosingCard
  ];

  evidence?: Evidence[];
};
```

### Card 1: Cover

```ts
type CoverCard = {
  type: "cover";
  badge: string;
  title: string;
  subtitle: string;
  activity: number[];
  footer: string;
  evidence_refs?: string[];
};
```

Use the cover to name the period and the persona. The title can be an archetype
label such as "The Architect"; the subtitle should summarize the period's real
dominant work in one line.

### Card 2: Thinking Path

```ts
type ThinkingPathCard = {
  type: "thinking_path";
  title: string;
  items: Array<{
    day: string;
    prompt: string;
    outcome: string;
    evidence_refs?: string[];
  }>;
};
```

Pick 3-6 turning points. A `prompt` is the question, friction, or task that
started the path. An `outcome` is the decision, fix, or learned framing.

### Card 3: Vibe

```ts
type VibeCard = {
  type: "vibe";
  title: string;
  observations: Array<{
    label: string;
    text: string;
    count?: number;
    time?: string;
    evidence_refs?: string[];
  }>;
  meter?: {
    label: string;
    value: number;
    caption: string;
  };
  quote?: {
    text: string;
    caption?: string;
    evidence_refs?: string[];
  };
};
```

This card can be playful, but it must stay grounded. Repeated phrases should be
counted from visible user messages, not meta messages or tool results.

### Card 4: Workflows Or Tools

```ts
type WorkflowOrToolsCard = {
  type: "workflow" | "tool_habits" | "debugging" | "shipping";
  title: string;
  summary?: string;
  stats?: string;
  items: Array<{
    name: string;
    outcome: string;
    evidence_refs?: string[];
  }>;
  verdict: string;
};
```

Choose the card type that best fits the period. Use `workflow` when workflow
runs or subagents are the story; `debugging` when failures and fixes dominate;
`shipping` when completed implementation dominates; `tool_habits` when the
period is mostly about how the user worked.

### Card 5: Closing

```ts
type ClosingCard = {
  type: "closing";
  headline: string;
  stats: string[];
  most_said_phrase?: string;
  signoff: string;
  evidence_refs?: string[];
};
```

Close with one high-signal stat and a short signoff. Avoid turning the closing
card into a second summary.

### Evidence

```ts
type Evidence = {
  id: string;
  session_id?: string;
  message_uuid?: string;
  memory_id?: string;
  summary?: string;
};
```

Evidence is for local traceability and app inspection. It does not have to be
shown on exported cards. Prefer short summaries over raw snippets.

## Output Rules

- If the user asks for app handoff, return one JSON object and no surrounding
  prose.
- If the user asks conversationally, answer with the card content naturally and
  include JSON only if useful.
- Keep `cards.length === 5` in the order above.
- Do not include unsupported cards just to fill space. It is better to make a
  quieter card than to invent drama.
- Do not include raw SQL, query scripts, or private evidence in the shareable
  card text.

## Minimal Example

```json
{
  "schema_version": "obelisk.recap.v1",
  "kind": "weekly",
  "generated_at": "2026-06-13T03:40:00+08:00",
  "period": {
    "label": "Week 24",
    "start": "2026-06-08",
    "end": "2026-06-14",
    "timezone": "Asia/Shanghai"
  },
  "source": {
    "project": "quiet-zero",
    "session_ids": ["sid-a", "sid-b"],
    "memory_ids": ["mem-a"]
  },
  "metrics": {
    "sessions": 12,
    "messages": 847,
    "tokens": 2400000,
    "active_days": [1, 1, 1, 0, 1, 1, 1],
    "workflows": 3,
    "workflow_agents": 42
  },
  "persona": {
    "archetype": "architect",
    "title": "The Architect",
    "subtitle": "Designed a memory system from raw sessions to durable notes.",
    "tone": "matter-of-fact, structural pride"
  },
  "cards": [
    {
      "type": "cover",
      "badge": "Week 24",
      "title": "The Architect",
      "subtitle": "Designed a full memory layer without turning sessions into a wiki.",
      "activity": [1, 1, 1, 0, 1, 1, 1],
      "footer": "12 sessions - 2.4M tokens",
      "evidence_refs": ["e1", "e2"]
    },
    {
      "type": "thinking_path",
      "title": "Your thinking path",
      "items": [
        {
          "day": "Mon",
          "prompt": "Why compile sessions into a wiki?",
          "outcome": "Kept raw SQLite as the evidence layer.",
          "evidence_refs": ["e1"]
        }
      ]
    },
    {
      "type": "vibe",
      "title": "Your vibe this week",
      "observations": [
        {
          "label": "Catchphrase",
          "text": "This is too ugly.",
          "count": 4,
          "evidence_refs": ["e3"]
        }
      ],
      "meter": {
        "label": "Patience",
        "value": 0.8,
        "caption": "saint"
      }
    },
    {
      "type": "workflow",
      "title": "Are you a Workflow Enjoyer?",
      "stats": "3 workflows - 42 agents",
      "items": [
        {
          "name": "hono-plugin-review",
          "outcome": "perfect",
          "evidence_refs": ["e4"]
        }
      ],
      "verdict": "Mostly tolerated"
    },
    {
      "type": "closing",
      "headline": "19 day streak",
      "stats": ["847 messages exchanged"],
      "most_said_phrase": "Okay, start doing it.",
      "signoff": "See you next week.",
      "evidence_refs": ["e5"]
    }
  ],
  "evidence": [
    {
      "id": "e1",
      "session_id": "sid-a",
      "message_uuid": "msg-a",
      "summary": "The user chose raw SQLite as the evidence layer."
    }
  ]
}
```
