// Phase 6 acceptance: `npm run build:skill` must produce a runnable, readable,
// .ts-free skill artifact under dist/obelisk-skill. This guards ADR-0004 (ship
// readable non-bundled compiled JS) and catches import-rewriting / config drift
// that would only surface when the installed skill runs under plain Node (no
// type-stripping, no .ts resolution).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillDir = join(repoRoot, 'dist', 'obelisk-skill');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

test('build:skill produces a runnable, readable, .ts-free skill artifact', () => {
  execFileSync('npm', ['run', 'build:skill'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });

  // Structure: compiled Core + schema + docs + package.json.
  for (const rel of [
    'package.json', 'SKILL.md', 'references/api-reference.md',
    'scripts/core.js', 'scripts/persist.js', 'scripts/providers/claude.js',
    'scripts/providers/codex.js', 'scripts/runtime.js', 'scripts/indexer.js',
    'scripts/db.js', 'scripts/parsing.js', 'scripts/query.js', 'scripts/schema.sql',
  ]) {
    assert.ok(existsSync(join(skillDir, rel)), `artifact missing ${rel}`);
  }
  assert.equal(JSON.parse(readFileSync(join(skillDir, 'package.json'), 'utf8')).type, 'module');

  // Readable, not bundled: emitted files stay ~1:1 with source, and no relative
  // import may still point at a .ts file (that would break under plain Node).
  const jsFiles = walk(join(skillDir, 'scripts')).filter(f => f.endsWith('.js') || f.endsWith('.mjs'));
  assert.ok(jsFiles.length >= 6, 'expected multiple un-bundled script files');
  for (const file of jsFiles) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/from\s+['"][^'"]*\.ts['"]/.test(src), `${file} still imports a .ts module`);
    assert.ok(!/import\(['"][^'"]*\.ts['"]\)/.test(src), `${file} still dynamic-imports a .ts module`);
  }

  // Runs end to end under plain Node against a fresh HOME (no type-stripping).
  const home = mkdtempSync(join(tmpdir(), 'obelisk-skill-artifact-'));
  try {
    const projDir = join(home, '.claude', 'projects', '-tmp-proj');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'smoke.jsonl'),
      JSON.stringify({ uuid: 'm1', type: 'user', timestamp: '2026-06-10T10:00:00Z', cwd: '/tmp/proj', message: { role: 'user', content: 'hello artifact' } }) + '\n');
    const env = { ...process.env, HOME: home };
    const runtime = join(skillDir, 'scripts', 'runtime.js');

    const build = spawnSync(process.execPath, [runtime, '--build'], { env, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const search = spawnSync(process.execPath, [runtime, '--search', 'hello artifact'], { env, encoding: 'utf8' });
    assert.equal(search.status, 0, search.stderr || search.stdout);
    const hits = JSON.parse(search.stdout);
    assert.equal(hits[0]?.message?.text, 'hello artifact', 'compiled artifact indexed and found the message');

    const memoryPath = join(home, 'artifact-memory.md');
    const attunePath = join(home, 'attune.mjs');
    writeFileSync(memoryPath, '# Artifact memory\n');
    writeFileSync(attunePath, `return remember(${JSON.stringify({
      path: memoryPath,
      session_id: 'smoke',
      summary: 'Artifact release smoke memory',
    })});`);
    const attune = spawnSync(process.execPath, [runtime, '--attune', attunePath], { env, encoding: 'utf8' });
    assert.equal(attune.status, 0, attune.stderr || attune.stdout);
    assert.match(JSON.parse(attune.stdout).id, /^mem-/);

    const queryPath = join(home, 'query.mjs');
    writeFileSync(queryPath, "return memories({ sessionId: 'smoke', query: 'Artifact release smoke' });");
    const query = spawnSync(process.execPath, [runtime, '--query', queryPath], { env, encoding: 'utf8' });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    assert.equal(JSON.parse(query.stdout)[0]?.summary, 'Artifact release smoke memory');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
