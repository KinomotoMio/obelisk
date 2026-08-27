// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as ObeliskPlugin from '../packages/dsh-plugin/src/index.ts'

const { apply, inject } = ObeliskPlugin

const repoRoot = resolve(import.meta.dirname, '..')
const canonicalRoot = join(repoRoot, 'skill-doc')
const canonicalSkill = readFileSync(join(canonicalRoot, 'SKILL.md'), 'utf8')

function bodyOf(raw) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw)
  assert.ok(match, 'canonical skill must have frontmatter')
  return raw.slice(match[0].length).trim()
}

function boot() {
  let provider = null
  const ctx = {
    skills: {
      registerProvider(factory) {
        provider = factory({ signal: new AbortController().signal, invalidate() {} })
        return () => { provider = null }
      },
    },
  }
  apply(ctx)
  assert.ok(provider)
  return provider
}

test('depends only on the standard DSH skill registry', () => {
  assert.deepEqual(inject, ['skills'])
  boot()
})

test('registers the canonical Obelisk skill as a bundled provider', async () => {
  const provider = boot()
  const candidates = await provider.list()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, 'obelisk')
  assert.equal(candidates[0].provider, '@obelisk/dsh-obelisk-plugin')
  assert.equal(candidates[0].source, 'bundled')
  assert.deepEqual(candidates[0].invocation, { modelInvocable: true, userInvocable: true })
  assert.match(candidates[0].description, /Search and query past Claude Code, Codex, Kimi Code, and Pi session history/)

  const loaded = await provider.get(candidates[0])
  assert.equal(loaded.content, bodyOf(canonicalSkill))
  assert.equal(loaded.resourceBase.kind, 'directory')
  assert.equal(resolve(loaded.resourceBase.path), canonicalRoot)
})

test('exposes every resource referenced by the canonical skill', async () => {
  const loaded = await boot().get()
  const references = [...loaded.content.matchAll(/`(references\/[^`]+\.md)`/g)].map(match => match[1])
  assert.ok(references.length > 0)
  for (const relative of new Set(references)) {
    assert.equal(existsSync(join(loaded.resourceBase.path, relative)), true, relative)
  }
})

test('loads and unloads through the real DSH skill registry', async () => {
  const packageRequire = createRequire(new URL('../packages/dsh-plugin/package.json', import.meta.url))
  const { Context } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/cordis')).href)
  const { default: SkillRegistry } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-skill')).href)
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const fiber = await ctx.plugin(ObeliskPlugin)

  assert.deepEqual((await ctx.skills.list()).map(skill => skill.name), ['obelisk'])
  assert.equal((await ctx.skills.get('obelisk'))?.content, bodyOf(canonicalSkill))

  await fiber.dispose()
  assert.deepEqual(await ctx.skills.list(), [])
})
