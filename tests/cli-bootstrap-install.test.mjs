import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('root SKILL.md bootstraps the CLI before installing the official skill', () => {
  const source = readFileSync(join(repoRoot, 'SKILL.md'), 'utf8');

  assert.match(source, /@obelisk-apps\/cli/);
  assert.match(source, /install\.sh/);
  assert.match(source, /obelisk --version/);
  assert.match(source, /obelisk install/);
  assert.doesNotMatch(source, /obelisk --query/);
});

test('install.sh installs and verifies only the CLI', () => {
  const home = mkdtempSync(join(tmpdir(), 'obelisk-install-script-'));
  const fakeBin = join(home, 'bin');
  const npmCapture = join(home, 'npm-args');
  const obeliskCapture = join(home, 'obelisk-args');
  mkdirSync(fakeBin, { recursive: true });

  const npm = join(fakeBin, 'npm');
  writeFileSync(npm, `#!/bin/sh\nprintf '%s\\n' "$@" > "${npmCapture}"\n`);
  chmodSync(npm, 0o755);

  const obelisk = join(fakeBin, 'obelisk');
  writeFileSync(obelisk, `#!/bin/sh\nprintf '%s\\n' "$@" > "${obeliskCapture}"\nprintf '0.1.0\\n'\n`);
  chmodSync(obelisk, 0o755);

  const result = spawnSync('sh', [join(repoRoot, 'install.sh')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}${delimiter}${process.env.PATH || ''}`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readFileSync(npmCapture, 'utf8').trim().split('\n'), [
    'install',
    '--global',
    '@obelisk-apps/cli',
  ]);
  assert.deepEqual(readFileSync(obeliskCapture, 'utf8').trim().split('\n'), ['--version']);
});
