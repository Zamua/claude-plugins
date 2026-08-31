import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonActionAuthorizationRepository } from './json-action-authorization-repository'
import { createActionAuthorization } from '../domain/action-authorization'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function request(id = 'auth-1') {
  return createActionAuthorization({
    id,
    topic: '1133',
    sessionId: 'session-1',
    toolName: 'Bash',
    toolInput: { command: 'git push', description: 'Push the reviewed branch' },
    reason: 'Blocked by classifier',
    requestedAt: Date.parse('2026-08-31T14:00:00Z'),
    ttlMs: 15 * 60_000,
  })
}

function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-authorization-repo-'))
  dirs.push(dir)
  const file = join(dir, 'action-authorizations.json')
  return { file, repo: new JsonActionAuthorizationRepository(file) }
}

describe('JSON action authorization repository', () => {
  test('persists requests atomically with private permissions', () => {
    const { file, repo } = repository()
    repo.save(request())

    const reopened = new JsonActionAuthorizationRepository(file)
    expect(reopened.get('auth-1')?.details).toBe('git push')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
  })

  test('updates one aggregate without duplicating it and supports removal', () => {
    const { repo } = repository()
    repo.save(request())
    repo.save({ ...request(), telegramMessageId: 7200 })
    expect(repo.list()).toHaveLength(1)
    expect(repo.get('auth-1')?.telegramMessageId).toBe(7200)

    repo.remove('auth-1')
    expect(repo.get('auth-1')).toBeUndefined()
  })

  test('returns copies so callers cannot mutate persisted state accidentally', () => {
    const { repo } = repository()
    repo.save(request())
    const loaded = repo.get('auth-1')!
    loaded.details = 'rm -rf /'

    expect(repo.get('auth-1')?.details).toBe('git push')
  })
})
