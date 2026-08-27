# @obelisk/dsh-obelisk-plugin

Optional Obelisk skill provider for DeepSeek Harness (DSH). The plugin bundles
the canonical [`obelisk` skill](../../skill-doc/SKILL.md) and contributes it to
DSH's standard skill registry.

The integration intentionally adds no dedicated model tool, system-prompt
section, frontend tool card, or DSH source change. Once the model loads the
skill through DSH's existing `skill` tool, it follows the same
`obelisk --query ...` Bash workflow used in every other supported agent
harness. See [ADR-0009](../../docs/adr/0009-obelisk-as-dsh-optional-retrieval-plugin.md).

## Prerequisite

Install the Obelisk CLI so `obelisk` is available on `PATH`:

```bash
npm install --global @obelisk-apps/cli
```

The plugin already carries the complete skill bundle, including its referenced
documents. A separate `obelisk install` is not required for DSH.

## Enable

From the Obelisk repository root, build the plugin, install the local package
into the target DSH profile, then add its row through the supplied patch:

```bash
npm run build --workspace @obelisk/dsh-obelisk-plugin
dsh plugin --profile web add "$PWD/packages/dsh-plugin"
dsh --profile web --patch "$PWD/packages/dsh-plugin/obelisk.cordis.yml" web
```

The row is opt-in; without it, DSH behaves exactly as before. The plugin has no
configuration or settings page.

## Model experience

DSH advertises `obelisk` in its normal skill catalog. When session history or a
past decision may help, the model loads that skill through the normal `skill`
tool and receives the canonical Obelisk instructions. The skill then uses the
ordinary Bash tool to run the CLI.

A project-local skill with the same name can override this bundled copy through
DSH's existing skill precedence rules. The packaged copy is built directly from
`skill-doc/`, so the DSH integration does not maintain a second version of the
instructions.

## Presentation

Obelisk commands remain visibly ordinary Bash calls. DSH's current keyed tool
view API can replace the complete Bash renderer but cannot decorate only
recognized Obelisk commands. This integration does not change DSH or introduce
a second tool identity merely to obtain branding.

## Limitations

- Obelisk is a local snapshot archive; just-finished sessions appear after its
  next index refresh.
- The canonical skill intentionally exposes the same machine-wide archive and
  human-approved memory flow as other harnesses.
- If the CLI is absent, the standard Bash call reports the command failure.

## Development

```bash
npm install
npm run typecheck --workspace @obelisk/dsh-obelisk-plugin
npm run build --workspace @obelisk/dsh-obelisk-plugin
node --experimental-test-module-mocks --test tests/dsh-plugin.test.mjs
```
