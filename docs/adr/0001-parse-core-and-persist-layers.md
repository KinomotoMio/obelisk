# Indexing is a registry of pure provider adapters over one shared persist layer

> Revised 2026-07-08. The first draft framed the parse layer as a single "parse
> core" with "two thin persist layers, one per binding." That was wrong on both
> axes and is corrected below: the parse layer is a *registry of per-provider
> adapters* (driven by the multi-provider roadmap), and there is *one* shared
> persist layer, not one per binding.

**Context.** Obelisk had two divergent full indexers — the former
`scripts/indexer.mjs` (`node:sqlite`, skill/runtime) and `app/indexer.js`
(`better-sqlite3`, Electron
app) — that duplicated the same Claude and Codex JSONL parsing and had silently
diverged in write semantics (`INSERT OR REPLACE` vs `ON CONFLICT DO UPDATE`,
message-count accumulation). Two forces shape the fix: (1) the roadmap will add
more transcript sources — opencode, pi, and others — so the parse layer must be
*pluggable*, not one monolith; (2) `node:sqlite` and `better-sqlite3` share the
same `prepare/run/get/all` API, so persistence is *already* nearly
binding-agnostic and does not need a per-binding implementation.

**Decision.** Split indexing along two orthogonal axes.

- **Provider axis — a registry of pure adapters.** Each source (claude, codex,
  later opencode, pi, …) is a provider adapter implementing
  `discover(opts) → files` and `parse(file, fromLine) → Iterable<Record>`. An
  adapter is *pure*: it emits normalized records and never touches a database.
  Adding a source means adding one adapter and registering it; nothing else
  changes. `parse` is a streaming iterator, preserving memory-friendly indexing
  and the `lines_processed` resume-from-line semantics in `index_state`.
- **Persist axis — one shared orchestration.** A single provider-agnostic,
  binding-agnostic layer consumes records from any adapter and writes them:
  incremental `index_state` bookkeeping, FTS maintenance, and the canonical
  **upsert** (`ON CONFLICT(uuid) DO UPDATE`) write semantics reconciled from the
  drift on 2026-07-08. The database handle is *injected*, so `node:sqlite`
  (skill/CLI) and `better-sqlite3` (app) run the same code — there is no
  per-binding persist layer.

**Two indexing modes** share all of the above and differ only in trigger:
**daemon mode** (app/CLI watches and keeps the index fresh) and **passive pull
mode** (skill indexes on invocation when no daemon is active). They never write
concurrently — passive mode detects a fresh daemon via heartbeat markers in
`index_state` (**daemon arbitration**).

**Consequences.** Golden tests anchor on each adapter's `parse` output (feed
fixture JSONL, assert the yielded record sequence) — independent of binding and
persistence. The app's richer changed-path discovery becomes a `discover`
strategy injected into the shared orchestration, not a fork of it. The Electron
main process migrates to ESM (ADR-0003) to import the shared core. The real work
is disentangling the currently interleaved parse-and-write inside `indexJsonl` /
`indexCodexJsonl` into (pure adapter parse) + (shared persist).
