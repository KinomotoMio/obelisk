# Core is authored in TypeScript, shipped as precompiled ESM JavaScript

**Context.** The extracted Obelisk Core must serve two consumers — the ESM skill
runtime (`node:sqlite`) and the CommonJS Electron app (`better-sqlite3`) — while
the skill artifact must install with **zero build step** on the user's machine
(the clone-and-run, "low-friction skill" goal). Authoring in TS gives the infra
its checkable contracts, but raises how the compiled output is shipped and which
module format it targets.

**Decision.** Author all of Core in the `@obelisk/core` npm workspace
(`packages/core`) in TypeScript and compile it ahead-of-time to
**ESM JavaScript plus `.d.ts`**. The skill/CLI runtime ships the *precompiled*
ESM JS, so installing the skill never runs a build. Rather than have Core
dual-publish CJS+ESM, the Electron main process migrates to ESM at Phase 5 so it
can `import` the same compiled Core. TypeScript source is the single source of
truth; the build step lives in the main repo (`build:skill`), never on the user's
machine.

**Consequences.** A one-time ESM migration of the Electron main process (Phase 5),
in exchange for no dual-build maintenance and a single module format across skill,
CLI, and app. The shipped skill artifact contains compiled JS, not TS. The
renderer (Vue) is out of scope and stays JavaScript. Phase 3's TS baseline only
adds root tooling (package.json, tsconfig, ESLint); it does not touch the app.
The app imports Core source so electron-vite can bundle it, while package and
skill builds compile the same workspace source to JavaScript.
