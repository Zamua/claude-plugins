import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { renderPaneTurn } from '../shared/domain/inbound-delivery'
import { RELAUNCH_META, reminderMeta, SECRET_DROP_META, SQUARE_META } from '../shared/domain/turn-meta'
import { ROUTE } from '../http/routes'

const hooks = join(import.meta.dir, '..', '..', 'hooks')

// Runs the real Stop hook on a transcript whose last user turn carries `meta`
// and whose answer never called a tool; returns whether the hook blocked the stop.
function blocksSilentStop(meta: Record<string, string>): boolean {
  const home = mkdtempSync(join(tmpdir(), 'tg-hook-'))
  const transcript = join(home, 'transcript.jsonl')
  const turn = renderPaneTurn({ content: 'hello', meta: { chat_id: '-1001', user: 'u', ...meta } })
  writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: turn } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answered in the transcript' }] } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  const result = spawnSync('python3', [join(hooks, 'stop-reply-guard.py')], {
    input: JSON.stringify({ transcript_path: transcript, stop_hook_active: false, session_id: 's' }),
    encoding: 'utf8',
    env: { HOME: home, PATH: '/usr/bin:/bin:/opt/homebrew/bin' },
  })
  expect(result.status).toBe(0)
  return result.stdout.includes('"decision": "block"')
}

describe('stop-reply-guard.py and the proxy meta flags', () => {
  test('an operator message answered only in the transcript is blocked', () => {
    expect(blocksSilentStop({})).toBeTrue()
  })

  test('turns the proxy marks as needing no reply may end in silence', () => {
    expect(blocksSilentStop(SQUARE_META)).toBeFalse()
    expect(blocksSilentStop(SECRET_DROP_META)).toBeFalse()
    expect(blocksSilentStop(reminderMeta(false))).toBeFalse()
  })

  test('turns that ask for an answer still need one', () => {
    expect(blocksSilentStop(reminderMeta(true))).toBeTrue()
    expect(blocksSilentStop(RELAUNCH_META)).toBeTrue()
  })
})

describe('Python hooks and the proxy routes', () => {
  test('every route a hook posts to is one the proxy serves', () => {
    const served = new Set<string>(Object.values(ROUTE))
    for (const hook of ['rate-limit-failover.py', 'provider-capacity-status.py']) {
      const source = readFileSync(join(hooks, hook), 'utf8')
      const used = [...source.matchAll(/proxy\}?\s*\+?\s*"(\/[a-z/-]+)"|\{proxy\}(\/[a-z/-]+)/g)]
        .map(m => m[1] ?? m[2])
      expect(used.length).toBeGreaterThan(0)
      for (const route of used) expect([hook, served.has(route)]).toEqual([hook, true])
    }
  })
})
