// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DeepSeek Harness provider for the canonical Obelisk agent skill.
 *
 * The plugin adds no model tool and no prompt fragment of its own. DSH exposes
 * this packaged skill through its standard catalog and `skill` tool; after the
 * model loads it, Obelisk keeps the same Bash-based invocation contract used by
 * every other supported agent harness.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

/** Cordis plugin name used by Loader diagnostics. */
export const name = '@obelisk/dsh-obelisk-plugin'

/** The standard DSH skill registry is the plugin's only dependency. */
export const inject = ['skills']

const PROVIDER_NAME = '@obelisk/dsh-obelisk-plugin'
const PACKAGED_SKILL_ROOT = new URL('./skill/', import.meta.url)
const SOURCE_SKILL_ROOT = new URL('../../../skill-doc/', import.meta.url)

interface ParsedSkill {
  readonly name: string
  readonly description: string
  readonly content: string
}

function skillRoot(): URL {
  const packagedBody = fileURLToPath(new URL('SKILL.md', PACKAGED_SKILL_ROOT))
  return existsSync(packagedBody) ? PACKAGED_SKILL_ROOT : SOURCE_SKILL_ROOT
}

function parseSkill(raw: string): ParsedSkill {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') {
    throw new Error('bundled Obelisk skill is missing YAML frontmatter')
  }
  let lineStart = firstLineEnd + 1
  let closingStart = -1
  let bodyStart = -1
  while (lineStart <= raw.length) {
    const newline = raw.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? raw.length : newline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      closingStart = lineStart
      bodyStart = newline < 0 ? raw.length : newline + 1
      break
    }
    if (newline < 0) break
    lineStart = newline + 1
  }
  if (closingStart < 0 || bodyStart < 0) {
    throw new Error('bundled Obelisk skill has unterminated YAML frontmatter')
  }
  const data = parseYaml(raw.slice(firstLineEnd + 1, closingStart)) as unknown
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('bundled Obelisk skill frontmatter must be an object')
  }
  const skillName = Reflect.get(data, 'name')
  const description = Reflect.get(data, 'description')
  if (skillName !== 'obelisk' || typeof description !== 'string' || description.trim() === '') {
    throw new Error('bundled Obelisk skill frontmatter must define the canonical name and description')
  }
  return { name: skillName, description, content: raw.slice(bodyStart).trim() }
}

const root = skillRoot()
const bodyUrl = new URL('SKILL.md', root)
const resourceBase = { kind: 'directory', path: fileURLToPath(root) } as const
let loaded: Promise<ParsedSkill> | undefined

function loadSkill(): Promise<ParsedSkill> {
  loaded ??= readFile(bodyUrl, 'utf8').then(parseSkill)
  return loaded
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  async list(): Promise<SkillCandidate[]> {
    const skill = await loadSkill()
    return [{
      name: skill.name,
      description: skill.description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER_NAME,
      source: 'bundled',
      resourceBase,
      rank: BUNDLED_SKILL_RANK,
      locator: bodyUrl,
    }]
  },
  async get(): Promise<SkillDefinition> {
    const skill = await loadSkill()
    return {
      name: skill.name,
      description: skill.description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER_NAME,
      source: 'bundled',
      resourceBase,
      content: skill.content,
    }
  },
}

/** Register the packaged Obelisk skill without changing DSH itself. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
