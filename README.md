<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/obelisk-wordmark-d.svg">
  <img src=".github/assets/obelisk-wordmark-l2.svg" alt="Obelisk" width="540">
</picture>

[![stars](https://img.shields.io/github/stars/tommy0103/obelisk?style=flat-square)](https://github.com/tommy0103/obelisk/stargazers)
[![version](https://img.shields.io/github/v/tag/tommy0103/obelisk?label=version&style=flat-square)](https://github.com/tommy0103/obelisk/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)

Every past session, subagent, and workflow -- queryable by your agent.

**Humans should not browse session history. Agents should query it.**

</div>

<br />

<div align="center">
  <img src=".github/assets/demo.png" alt="Obelisk in action" width="540">
  <br />
  <p>Ask in plain language. The agent writes the query, runs it, answers.</p>
</div>

## Not a session browser

Most history tools help humans find old chats.

Obelisk is built for agents. It exposes past work as structured data: sessions,
messages, tool calls, subagents, workflows, file history, failures, parent
chains, and human-approved markdown memories. The agent writes the query, runs
it locally, and answers in plain language.

You don't manage history. You ask questions about past work.

## Why Obelisk

| Session library | Obelisk |
|---|---|
| Find an old chat | Answer a question about past work |
| Human browses snippets | Agent writes and runs a query |
| Search result list | Structured context and reasoning |
| Sessions as documents | Sessions as queryable memory |
| Good for recall | Good for investigation |

## What you can ask

```
/obelisk 上次 auth bug 最后到底改了哪些文件，为什么这么改
/obelisk 这个文件最近在哪些 sessions 里被反复修改
/obelisk 找出最近失败的 tool calls，它们分别发生在哪些任务里
/obelisk 那个 review workflow 的 subagents 各自结论是什么
/obelisk 我之前有没有试过这个方案，结果为什么放弃了
```

Anything Claude Code has done before -- sessions, tool calls, subagents, workflows -- becomes structured, queryable memory. Ask in your own words.

## Install

```bash
npx skills add tommy0103/obelisk
```

Or manually: copy `obelisk/` into your project's `.claude/skills/`.

Then in any Claude Code session:

```
/obelisk <your question>
```

First run builds the index (~5 seconds for 100 sessions). After that it rebuilds incrementally.

### Requires

- Node.js 22+ (uses built-in node:sqlite with FTS5)
- Claude Code with skills support.

## How it works

```
You ask a question
  ↓
Agent writes a JS query against the SQLite index
  ↓
Runs it via node runtime.mjs --query <script>
  ↓
Reads the JSON result, answers you in natural language
```

When a retrieval produces a memory worth keeping, the agent proposes a markdown
memory file. After user approval, it registers that file with the narrow
`runtime.mjs --attune <script>` runtime, which exposes only memory mutation
helpers such as `remember()` and `forget()`.

Memory is a synthesis cache, not a replacement for raw sessions. The agent can
decide whether to use, ignore, or verify a memory during an answer. Persistent
changes still require human approval, but explicit corrections count: if you say
a memory is wrong, outdated, or should be replaced, the agent can archive or
update the exact matching record without a second confirmation.

**The core idea: don't make humans browse, tag, or organize sessions.**
Don't invent a rigid query DSL either.

Agents can write code. So Obelisk gives them a small local query runtime over
your past work.

The agent starts from a small core API, then uses structured shortcuts and
references only when the question needs them:

**Core primitives** — the main CodeAct surface:

- `search(text)` — FTS5 full-text search, returns matches with surrounding context plus message `content_type` and `is_meta`
- `context(uuid)` — full story around a message (parent chain, subagent/workflow metadata)
- `sql(query, ...params)` — read-only SQL for structured queries

**Structured shortcuts** — overview, session, memory, summary, subagent,
workflow, file-history, failure, raw-window, and parent-chain helpers over the
same SQLite data.

**References** — agent reads on demand when the task needs deeper structure:

- `references/schema.md` — full SQLite schema and API reference
- `references/query-patterns.md` — copyable CodeAct recipes for common retrieval tasks
- `references/retrieval-semantics.md` — query design frame for scoped and synthesis retrieval
- `references/recap/overview.md` — optional `/obelisk recap` card-by-card entrypoint
- `references/recap/pattern1-cover.md` and `references/recap/writing1-cover.md`
- `references/recap/pattern2-thinking.md` and `references/recap/writing2-thinking.md`
- `references/recap/pattern3-vibe.md` and `references/recap/writing3-vibe.md`
- `references/recap/pattern4-workflow.md` and `references/recap/writing4-workflow.md`
- `references/recap/pattern5-closing.md` and `references/recap/writing5-closing.md`
- `references/pitfalls.md` — scope, FTS, ordering, compact/raw, and field-name traps

The executable SQLite schema lives in `scripts/schema.sql`; `references/schema.md`
is the human/agent explanation of that contract.

The design is progressive disclosure with guardrails: the main skill keeps the
core contract and high-risk pitfalls visible, while longer recipes and the full
schema stay out of the first prompt until the agent needs them.
The optional recap references are only for the explicit `/obelisk recap` intent;
they are not part of the ordinary retrieval path. `references/recap/overview.md`
drives a card-by-card loop: read one card's retrieval pattern, gather that
card's evidence, read its writing reference, update the JSON, then continue.
This keeps schema, taste, and query planning from competing in one large prompt.

## What gets indexed

| Layer | Source | What's captured |
|-------|--------|----------------|
| **Sessions** | `<project>/<sessionId>.jsonl` | Title, project, timestamps, git branch |
| **Messages** | user + assistant turns | Full text, model, token usage, parent chain |
| **Tool calls** | every tool invocation | Tool name, input, file paths touched |
| **Subagents** | `subagents/agent-<id>.jsonl` | Agent type, description, full conversation |
| **Workflows** | `workflows/wf_<runId>.json` | Script, structured result, agent count |
| **Workflow agents** | `subagents/workflows/wf_<runId>/` | Per-agent transcripts linked to workflow |
| **Memories** | markdown files registered by the agent after user approval | Prior conclusions linked to source sessions/messages and optional anchors |

Full-text search via FTS5 covers message text across every session layer and ranked memory recall over registered memory summaries, while the SQLite tables preserve the structure agents need for investigation.

## Structure

```
.claude/skills/obelisk/
├── SKILL.md              # Skill definition + simple API + examples
├── scripts/
│   ├── schema.sql        # Executable SQLite schema
│   └── runtime.mjs       # Indexer + query runtime (zero deps)
└── references/
    ├── schema.md          # Full table schema + advanced API reference
    ├── query-patterns.md  # Copyable retrieval recipes
    ├── retrieval-semantics.md # Query design frame for retrieval semantics
    ├── recap-patterns.md  # Compatibility pointer to references/recap/overview.md
    ├── recap-writing.md   # Compatibility pointer to per-card recap writing docs
    ├── recap/
    │   ├── overview.md
    │   ├── pattern1-cover.md
    │   ├── writing1-cover.md
    │   ├── pattern2-thinking.md
    │   ├── writing2-thinking.md
    │   ├── pattern3-vibe.md
    │   ├── writing3-vibe.md
    │   ├── pattern4-workflow.md
    │   ├── writing4-workflow.md
    │   ├── pattern5-closing.md
    │   └── writing5-closing.md
    └── pitfalls.md        # Scope, FTS, ordering, and compactness traps
```

## Implementation Notes

The index rebuilds incrementally — only new or modified JSONL files are re-parsed.
When the optional app is running, it is the active indexer: it watches Claude
project files and builds in a worker thread. A fresh `__app_heartbeat__` alone
means the daemon owns writes, so the skill remains read-only; a separate SQLite
writer lease prevents cross-process writes from overlapping. The
`__app_last_successful_build__` marker records index freshness, not ownership.

Zero npm dependencies. Uses Node 22's built-in node:sqlite with FTS5. The entire runtime is ~400 lines.

20K lines of scattered JSONL → something the agent can search() and sql() against in milliseconds.

---

## License

MIT @tommy0103
