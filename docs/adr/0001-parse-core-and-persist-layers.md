# Indexing splits into a shared parse core and binding-specific persist layers

**Context.** Obelisk had two divergent full indexers — `scripts/indexer.mjs`
(791 lines, `node:sqlite`, for the skill/runtime) and `app/indexer.js` (1170
lines, `better-sqlite3`, for the Electron app) — both parsing the same Claude and
Codex JSONL into the same schema. Keeping two implementations contradicts the
"single source of truth / infra" goal, but forcing one SQLite binding is also
bad: `node:sqlite` is zero-native-dep and ideal for a clone-and-run skill
artifact, while `better-sqlite3` is the battle-tested choice inside Electron.

**Decision.** Unify at the logic layer, not the binding layer. Extract a pure
**parse core** (`jsonl -> records`) with no database dependency, and keep two
thin **persist layers** (`node:sqlite` for skill/CLI, `better-sqlite3` for the
app) that consume the same records. The parse core is a **streaming iterator**
(`parseJsonl(file, fromLine)` yielding records), not a batched `records[]`, to
preserve the existing memory-friendly line-by-line indexing and the
`lines_processed` resume-from-line semantics recorded in `index_state`.

**Two indexing modes** share this parse core and differ only in trigger:
**daemon indexing mode** (app/CLI watches and keeps the index fresh) and
**passive pull mode** (skill indexes on invocation when no daemon is active).
They never write concurrently because the passive mode detects a fresh daemon via
heartbeat markers in `index_state` (**daemon arbitration**) and skips its own
indexing.

**Consequences.** Golden tests anchor on the parse core: feed a fixture JSONL,
assert the yielded record sequence — independent of binding. The refactor's real
work is disentangling parse from persist inside the current indexers, where
prepared-statement writes are today interleaved into the parse loop. The app's
richer incremental-discovery logic must be folded *into* the shared parse core,
not dropped.
