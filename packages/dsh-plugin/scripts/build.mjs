// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process'
import { cpSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(pluginRoot, '../..')
const outDir = resolve(pluginRoot, 'dist')
const tsc = resolve(repoRoot, 'node_modules/typescript/bin/tsc')

rmSync(outDir, { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '-p', resolve(pluginRoot, 'tsconfig.build.json')], {
  cwd: repoRoot,
  stdio: 'inherit',
})
cpSync(resolve(pluginRoot, 'skill'), resolve(outDir, 'skill'), { recursive: true })
