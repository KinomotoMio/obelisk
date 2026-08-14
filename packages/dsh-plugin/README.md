# @obelisk/dsh-plugin

Obelisk retrieval plugin for DeepSeek Harness. Mounts one read-only model tool,
`obelisk_query`, plus a short guidance section, giving the model a second
retrieval channel: `session_search` covers this tool's own prior sessions, while
`obelisk_query` covers the cross-tool archive (Claude Code, Codex, Kimi Code,
Pi) and the durable memory layer. See
[ADR-0009](../../docs/adr/0009-obelisk-as-dsh-optional-retrieval-plugin.md).

## Prerequisites

- The Obelisk CLI on `PATH` (`npm install --global @obelisk-apps/cli`),
  version 0.2.3 or newer — older releases lack the daemon-aware query refresh
  and fail while the desktop app holds the index write lease. The plugin runs
  `obelisk --query` per invocation, exactly like other agent harnesses.
- The Obelisk agent skill installed (`obelisk install --global`). The plugin
  does not embed or re-teach the skill; DeepSeek Harness discovers it from
  `~/.agents/skills` through its own skill filesystem, and the guidance text
  points the model at loading it with the `skill` tool before the first query.

## Enable

Add the plugin row to a harness patch, for example:

```bash
dsh web --patch packages/dsh-plugin/obelisk.cordis.yml
```

or add `obelisk.cordis.yml` to your profile's `cordis.patch.yml`. The plugin is
opt-in; a deployment without it behaves exactly as before.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `cliPath` | `obelisk` | Command used to run the Obelisk CLI. |
| `timeoutMs` | `30000` | Cooperative subprocess deadline for one invocation; must be 1000–120000. |
| `maxResultChars` | `24000` | Maximum characters returned to the model per invocation; must be 1000–1000000. |

## Model experience

One fixed guidance section plus one fixed tool schema are sent while the plugin
is mounted; the result is data-dependent plain text (the query's JSON return
value, capped). The tool deliberately exposes no index internals, no cursors,
and no mutation surface: memory writes and archives keep their human-approved
flow in the obelisk skill.

## Limitations

- **Batch freshness.** Obelisk is a snapshot archive; just-finished sessions
  appear after the next index refresh. Live history stays with `session_search`.
- **Single-writer index.** Queries reuse the CLI's incremental index refresh;
  while another process (for example the Obelisk desktop app) holds the index
  write lease, a query may fail with a readonly-database error.
- **Serial execution.** The tool does not declare itself concurrency-safe, so
  the harness executes it exclusively.
- **Version alignment.** Developed against `@deepseek-ai/dsh-tools` `0.0.1-rc.1`
  and `@deepseek-ai/cordis` `^4.0.1`; keep the host's copies aligned when
  upgrading.

## Development

```bash
npm install
npm run typecheck --workspace @obelisk/dsh-plugin
npm run build --workspace @obelisk/dsh-plugin
node --experimental-test-module-mocks --test tests/dsh-plugin.test.mjs
```
