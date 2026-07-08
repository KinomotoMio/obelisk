# Obelisk

Obelisk is explicit memory infrastructure for coding agents: it indexes local
Claude Code and Codex transcripts into a queryable SQLite evidence layer, and a
CodeAct runtime lets an agent write a small query, run it, and answer from real
session history. This glossary pins the terms that are specific to Obelisk; it is
not a spec.

## Runtime interface

**Runtime interface**:
The public contract, expressed as four verbs — `build`, `search(text)`,
`query(code)`, `attune(code)`. Skill, CLI, and MCP are transports over this same
shape; none of them add their own retrieval surface.
_Avoid_: API, tool surface

**CodeAct**:
The interaction style where an agent writes JavaScript that runs inside the
`query(code)` sandbox and returns JSON, rather than calling many fine-grained
tools. This is Obelisk's core design choice.
_Avoid_: tool-calling, function-calling

**Helper**:
A convenience accessor available only inside the `query(code)` sandbox
(`overview`, `search`, `context`, `sql`, `memories`, …). Helpers are never
promoted to an external tool surface.

## Indexing

**Parse core**:
The pure `jsonl -> records` transform. Given a transcript file and a start line,
it yields normalized index records. It does not open, own, or write to a
database, and is shared verbatim by every indexing mode. This is the layer that
must never be duplicated.
_Avoid_: parser, ingest

**Record**:
One normalized row destined for the index (session, message, tool call, tool
result, summary, subagent, workflow, …), emitted by the parse core before any
persistence happens.

**Persist layer**:
The thin, binding-specific writer that consumes records from the parse core and
writes them into SQLite inside a transaction. Two persist layers exist and differ
only in binding: `node:sqlite` (skill/CLI) and `better-sqlite3` (app).
_Avoid_: writer, sink, DAO

**Daemon indexing mode**:
Continuous incremental indexing driven by a long-lived process (the desktop app,
later a CLI daemon) that watches transcript directories and keeps the index fresh
as files change.
_Avoid_: watcher mode, live indexing

**Passive pull mode**:
On-demand incremental indexing performed by the skill when there is no active
daemon: an invocation of the runtime brings the index up to date, then answers.
_Avoid_: lazy indexing, on-read indexing

**index_state**:
The bookkeeping table shared by both indexing modes. It records, per transcript
path, the last-seen `mtime` and `lines_processed` (enabling resume-from-line
incremental indexing), plus heartbeat/last-build markers used for daemon
arbitration.

**Daemon arbitration**:
The mechanism by which the passive pull mode detects a fresh daemon (via
`__app_heartbeat__` and `__app_last_successful_build__` markers in `index_state`)
and skips its own indexing. Because a fresh daemon owns writes, the two persist
layers never write concurrently.

## Memory

**Queryable session memory**:
The evidence layer — real sessions, messages, tool calls, subagents, workflows —
that an agent queries on demand. Obelisk deliberately does this instead of
implicit/ambient memory.
_Avoid_: implicit memory, ambient memory, auto-recall

**Approved durable memory**:
Human-approved conclusions persisted as markdown plus a registry record, via
`attune(code)` calling `remember()`/`forget()`. Auditable and revocable.
_Avoid_: long-term memory, vector memory
