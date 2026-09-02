import { describe, expect, test } from 'bun:test'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  claudePluginSkillRoots,
  syncAntigravitySkills,
} from './antigravity-skill-interop'

describe('Antigravity skill compatibility adapter', () => {
  test('links portable Markdown skills and preserves native Antigravity skills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-skills-'))
    try {
      const source = join(dir, 'source')
      const target = join(dir, 'target')
      mkdirSync(join(source, 'portable'), { recursive: true })
      mkdirSync(join(source, 'not-a-skill'), { recursive: true })
      mkdirSync(join(target, 'native'), { recursive: true })
      writeFileSync(join(source, 'portable', 'SKILL.md'), '# portable\n')
      writeFileSync(join(target, 'native', 'SKILL.md'), '# native\n')

      const result = syncAntigravitySkills(target, [source])

      expect(result.linked).toContain('portable')
      expect(lstatSync(join(target, 'portable')).isSymbolicLink()).toBeTrue()
      expect(readlinkSync(join(target, 'portable'))).toBe(join(source, 'portable'))
      expect(lstatSync(join(target, 'native')).isDirectory()).toBeTrue()
      expect(result.linked).not.toContain('not-a-skill')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('discovers only enabled Claude plugins and excludes the Telegram channel plugin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-plugin-skills-'))
    try {
      const front = join(dir, 'front')
      const telegram = join(dir, 'telegram')
      mkdirSync(join(front, 'skills'), { recursive: true })
      mkdirSync(join(telegram, 'skills'), { recursive: true })
      const settings = join(dir, 'settings.json')
      const installed = join(dir, 'installed.json')
      writeFileSync(settings, JSON.stringify({ enabledPlugins: {
        'frontend@official': true,
        'telegram@official': true,
        'disabled@official': false,
      } }))
      writeFileSync(installed, JSON.stringify({ version: 2, plugins: {
        'frontend@official': [{ installPath: front }],
        'telegram@official': [{ installPath: telegram }],
      } }))

      expect(claudePluginSkillRoots(settings, installed, new Set(['telegram']))).toEqual([
        join(front, 'skills'),
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
