<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/obelisk-wordmark-d.svg">
  <img src=".github/assets/obelisk-wordmark-l2.svg" alt="Obelisk" width="540">
</picture>

[![stars](https://img.shields.io/github/stars/tommy0103/obelisk?style=flat-square)](https://github.com/tommy0103/obelisk/stargazers)
[![version](https://img.shields.io/github/v/tag/tommy0103/obelisk?label=version&style=flat-square)](https://github.com/tommy0103/obelisk/releases)
[![license](https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square)](LICENSE)

Every past Claude Code and Codex session -- queryable by your agent, browsable by you.

</div>

<br />

## Two sides of the same index

Obelisk has two sides that share one SQLite index:

**Skill side** — an agent skill that lets coding agents search and query their own session history. The agent writes JS queries, runs them locally, answers in plain language.

**App side** — an Electron desktop app for humans to browse sessions, manage memories, view usage stats, and see weekly recap cards.

Both read from the same `~/.obelisk/obelisk.sqlite` database. The indexer reads Claude Code transcripts from `~/.claude/projects` and Codex transcripts from `~/.codex/sessions`.

## Codex support

Obelisk indexes Claude Code and Codex into the same SQLite schema instead of keeping separate databases. Rows carry a `source` value (`claude` or `codex`), and Codex IDs are prefixed with `codex:` so they cannot collide with Claude session IDs.

Codex root threads become normal Obelisk sessions. Codex child threads are attached through the same `subagents` table when parent-thread metadata is available. Codex does not emit Claude-style workflow metadata, so workflow tables may be empty for Codex-only history.

For live app refresh, Obelisk watches `~/.claude/projects` and `~/.codex/sessions`. It does not watch the whole `~/.codex` root. Codex's `session_index.jsonl` is used as lightweight title/update metadata during indexing, not as the message transcript source.

## Skill: agent-first retrieval

<div align="center">
  <img src=".github/assets/demo.png" alt="Obelisk App" width="720">
</div>

You can use obelisk like:

```
/obelisk 上次 auth bug 最后到底改了哪些文件，为什么这么改
/obelisk 这个文件最近在哪些 sessions 里被反复修改
/obelisk 找出最近失败的 tool calls，它们分别发生在哪些任务里
/obelisk 那个 review workflow 的 subagents 各自结论是什么
/obelisk recap this week
```

### Install



```bash
npx skills add tommy0103/obelisk
```

Or manually: copy the skill into `.claude/skills/obelisk/`.

### How it works

```
You ask a question
  ↓
Agent writes a JS query against the SQLite index
  ↓
Runs it via node runtime.mjs --query <script>
  ↓
Reads the JSON result, answers in natural language
```

Core API: `search()`, `context()`, `sql()`, plus structured helpers (`sessions`, `memories`, `summaries`, `workflows`, `failures`, `fileHistory`, etc).

### Memory layer

When a retrieval produces a conclusion worth keeping, the agent proposes a markdown memory file. After user approval, it registers the file with `runtime.mjs --remember`. Memories are recalled via `memories()` in future sessions — a synthesis cache, not a replacement for raw evidence.

## App: A surface for human

A companion desktop app for browsing what the skill indexes.

<div align="center">
  <img src=".github/assets/app-screenshot.png" alt="Obelisk App" width="720">
</div>

- **Sessions** — browse all sessions with search, project filtering, readable tool calls (diffs, terminal output, file viewers)
- **Memory** — list and detail views for registered memory files
- **Activity** — GitHub-style heatmap, weekly/cumulative token charts
- **Recap** — shareable weekly/monthly recap cards with archetype theming
- **Settings** — data source configuration, auto-refresh, rebuild index

macOS only. Download from [Releases](https://github.com/tommy0103/obelisk/releases).

## What gets indexed

| Layer | Source | What's captured |
|-------|--------|----------------|
| **Sessions** | Claude `<project>/<sessionId>.jsonl`; Codex `sessions/YYYY/MM/DD/*.jsonl` | Title, project, timestamps, git branch, source |
| **Messages** | user + assistant turns | Full text, model, token usage, parent chain |
| **Tool calls** | every tool invocation | Tool name, input, file paths |
| **Subagents** | Claude `subagents/agent-<id>.jsonl`; Codex child threads | Agent type, description, full conversation |
| **Workflows** | Claude `workflows/wf_<runId>.json` | Script, result, agent count |
| **Workflow agents** | Claude `subagents/workflows/wf_<runId>/` | Per-agent transcripts |
| **Memories** | registered markdown files | Conclusions linked to source sessions |

Full-text search via FTS5 covers all layers.

## Structure

```
scripts/              # Skill runtime (zero npm deps, Node 22 built-in sqlite)
├── schema.sql        # Executable SQLite schema
├── runtime.mjs       # Indexer + query runtime
├── db.mjs            # Schema init, migrations
├── indexer.mjs       # JSONL discovery + incremental indexing
└── query.mjs         # Query API (search, sessions, memories, etc)

references/           # Agent-readable docs (progressive disclosure)
├── schema.md
├── query-patterns.md
├── retrieval-semantics.md
├── recap-patterns.md
├── recap/            # Per-card pattern + writing references
└── pitfalls.md

SKILL.md              # Skill definition + API + retrieval strategy
```

## Implementation Notes

- Index rebuilds incrementally — only new/modified JSONL files are re-parsed
- Skill side uses Node 22 built-in `node:sqlite`; zero npm dependencies
- Older `~/.claude/obelisk.sqlite` databases are copied forward to `~/.obelisk/obelisk.sqlite` on first open
- `~/.obelisk/recap/` watched for new recap JSON files (agent writes, app renders)

---

## License

AGPL-3.0 @tommy0103
