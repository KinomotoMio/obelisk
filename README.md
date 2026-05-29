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
messages, tool calls, subagents, workflows, file history, failures, and parent
chains. The agent writes the query, runs it locally, and answers in plain language.

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

**The core idea: don't make humans browse, tag, or organize sessions.**
Don't invent a rigid query DSL either.

Agents can write code. So Obelisk gives them a small local query runtime over
your past work.

The agent has a two-tier API. Most questions only need the simple layer:

**Simple API** — taught directly in the skill prompt:

- `search(text)` — FTS5 full-text search, returns matches with surrounding context
- `context(uuid)` — full story around a message (parent chain, subagent/workflow metadata)
- `sql(query, ...params)` — raw SQL for anything else

**Advanced API** — agent reads `references/schema.md` on demand:

- `trace()` · `thread()` · `subagents()` · `workflows()` · `workflowTree()` · `fileHistory()` · `failures()` · `recent()`

The design is progressive disclosure: the agent doesn't see the full schema until it needs it.

## What gets indexed

| Layer | Source | What's captured |
|-------|--------|----------------|
| **Sessions** | `<project>/<sessionId>.jsonl` | Title, project, timestamps, git branch |
| **Messages** | user + assistant turns | Full text, model, token usage, parent chain |
| **Tool calls** | every tool invocation | Tool name, input, file paths touched |
| **Subagents** | `subagents/agent-<id>.jsonl` | Agent type, description, full conversation |
| **Workflows** | `workflows/wf_<runId>.json` | Script, structured result, agent count |
| **Workflow agents** | `subagents/workflows/wf_<runId>/` | Per-agent transcripts linked to workflow |

Full-text search via FTS5 covers message text across every layer, while the SQLite tables preserve the structure agents need for investigation.

## Structure

```
.claude/skills/obelisk/
├── SKILL.md              # Skill definition + simple API + examples
├── scripts/
│   └── runtime.mjs       # Indexer + query runtime (400 lines, zero deps)
└── references/
    └── schema.md          # Full table schema + advanced API + query patterns
```

## Implementation Notes

The index rebuilds incrementally — only new or modified JSONL files are re-parsed.

Zero npm dependencies. Uses Node 22's built-in node:sqlite with FTS5. The entire runtime is ~400 lines.

20K lines of scattered JSONL → something the agent can search() and sql() against in milliseconds.

---

## License

MIT @tommy0103

