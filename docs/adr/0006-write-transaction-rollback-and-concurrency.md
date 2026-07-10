# Write-transaction rollback safety and SQLite concurrency

**Context.** The app surfaced `Obelisk index build failed: cannot rollback - no
transaction is active`. That message is a *secondary* error: SQLite auto-rolls
back certain failures (notably `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT`, also disk
full), after which the per-file build loop's unguarded `db.exec('ROLLBACK')` in
its `catch` threw over the real error and aborted the whole build instead of
skipping just the offending file. The underlying trigger is concurrency: the app
runs a daemon indexer, manual rebuilds, and read queries against one WAL
database, and the skill's passive-pull build can write the same database from a
separate process.

`busy_timeout` is **not** the root-cause fix and must not be treated as one.
better-sqlite3's constructor already defaults `timeout` to 5000ms, so the app hit
`SQLITE_BUSY` *despite* a 5s wait — which points at `SQLITE_BUSY_SNAPSHOT` from
deferred (read-then-write) transactions, a snapshot conflict that `busy_timeout`
does not wait on. Only `BEGIN IMMEDIATE` plus whole-transaction retry addresses
that.

**Decision.** Split the work into a cheap stopgap now and a correctness/
concurrency fix later.

*Stopgap (done).* Both indexers use a guarded rollback (`safeRollback`): a
cleanup rollback swallows only its own error and never masks the primary one.
Per-file failures are logged and the build continues; the finalize failure still
propagates. The skill's connection (`node:sqlite`, which has **no** default busy
timeout) gets an explicit `PRAGMA busy_timeout = 5000`; the app adds no such
pragma because better-sqlite3 already defaults to 5000ms — adding it there was
redundant and removed, precisely so nobody reads it as "the fix".

*Planned full fix (deferred, two phases).*

Phase 1 — transaction semantics:
- A shared, binding-agnostic `runWriteTransaction(db, work)` (same injection
  model as `persist`): BEGIN → work → COMMIT, guarded rollback on failure,
  original exception always preserved. Both app and skill call it, so their
  behaviour is identical.
- Per-file callers catch and continue; finalize does **not** swallow — a finalize
  failure fails the build (the skill currently only warns; that changes).
- In-memory state such as `affectedSessionIds` is updated **only after** a
  successful COMMIT (today the app adds the id before COMMIT, so a failed commit
  can report a wrong affected set).
- Structured diagnostics: `phase` (begin/file-write/commit/finalize/checkpoint),
  SQLite `code`, file path, whether rollback succeeded, whether a txn is still
  active; surface the skipped-file count in the build result rather than only
  `console.warn` (no silent coverage gaps).

Phase 2 — concurrency:
- A stable concurrency test against real Electron `better-sqlite3` (daemon +
  rebuild + skill writer), not an injected fake BUSY. Note this cannot run under
  standalone `node --test` (better-sqlite3 is Electron-ABI); it needs an
  Electron-hosted harness. The fast injected-BUSY unit test is kept as a
  lower-level guard for `runWriteTransaction`, alongside it.
- Serialize all index writes through a single writer: an in-process
  `BuildCoordinator`, plus the existing cross-process daemon arbitration
  (`__app_heartbeat__` markers) so the skill defers to a live daemon. Single
  writer = both layers together.
- `BEGIN IMMEDIATE` to take the write lock up front and avoid
  `SQLITE_BUSY_SNAPSHOT` on read-then-write.
- Bounded, short-backoff retry of the **whole** transaction (not the single
  failed statement) on `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT`. This relies on the
  per-file work being idempotent (upsert/replace + delete-session cascade), which
  it is — an invariant the retry depends on.
- Stop forcing `wal_checkpoint(TRUNCATE)` after every build; prefer a `PASSIVE`
  checkpoint on idle, with `TRUNCATE` reserved for maintenance/exit.
- Centralized connection configuration (explicit 5000ms for `node:sqlite` — a
  real behaviour change; explicit for better-sqlite3 too, acknowledging its
  default is already 5000ms).

**Consequences.** With only the stopgap in place, contention no longer crashes a
build, but a conflicting file is *skipped* (non-fatal) and its data is briefly
missing until the next build — acceptable as a stopgap because the guard keeps
the index consistent and self-healing. The true fix is tracked as the two-phase
plan above. A future contributor should not "fix" the concurrency by bumping or
re-adding `busy_timeout`; the direction is a shared transaction module, single
writer, `BEGIN IMMEDIATE`, and whole-transaction retry.
