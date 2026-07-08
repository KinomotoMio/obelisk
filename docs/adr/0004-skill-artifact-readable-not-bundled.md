# The skill artifact ships readable compiled JS, deliberately not bundled

**Context.** Obelisk reads a user's entire local Claude Code and Codex history,
so auditability is the foundation of trust: before a user lets the skill loose on
their data, they must be able to read what it does. The obvious way to shrink a
clone-and-run skill artifact is to bundle/minify Core into a single `runtime.js`,
but that ships an opaque blob into `.claude/skills` / `.agents/skills`. The
"don't drag the whole repo into the user's skills dir" concern is real but
separate — it is solved by shipping *only Core*, not by bundling.

**Decision.** The skill artifact ships **readable, non-bundled, non-minified**
compiled JavaScript emitted straight from `tsc` (module structure and comments
preserved, ~1:1 with the TypeScript source), plus `schema.sql`, `SKILL.md`, and
`references/`. It excludes `app/`, `release/`, `renderer/`, Electron code, and
`tests/`, which is what keeps it small. Bundling into one file is deliberately
rejected: it trades auditability for marginal size, the wrong trade for a
history-reading tool. The public TS source in the main repo allows cross-checking.

**Consequences.** The installed skill is a few readable files rather than one
blob; a future contributor may be tempted to "optimize" by bundling — this ADR
records that the un-bundled form is intentional. Small artifact size comes from
scoping the artifact to Core, handled by `build:skill`, not from a bundler.
