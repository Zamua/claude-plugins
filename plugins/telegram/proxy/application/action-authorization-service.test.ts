import { describe, expect, test } from 'bun:test'
import type {
  ActionAuthorization,
  ActionAuthorizationRepository,
} from '../domain/action-authorization'
import { ActionAuthorizationService } from './action-authorization-service'

class MemoryRepository implements ActionAuthorizationRepository {
  values = new Map<string, ActionAuthorization>()
  list() { return [...this.values.values()].map(value => structuredClone(value)) }
  get(id: string) {
    const value = this.values.get(id)
    return value ? structuredClone(value) : undefined
  }
  save(value: ActionAuthorization) { this.values.set(value.id, structuredClone(value)) }
  remove(id: string) { this.values.delete(id) }
}

const NOW = Date.parse('2026-08-31T14:00:00Z')
const denial = (over: Record<string, unknown> = {}) => ({
  id: 'auth-1',
  topic: '1133',
  sessionId: 'session-1',
  toolName: 'Bash',
  toolInput: { command: 'git push', description: 'Push the reviewed branch' },
  reason: 'Blocked by classifier',
  now: NOW,
  ...over,
})

describe('ActionAuthorizationService', () => {
  test('creates one durable request and deduplicates repeated classifier denials', () => {
    const repo = new MemoryRepository()
    const service = new ActionAuthorizationService(repo)

    const created = service.requestForDenial(denial())
    const duplicate = service.requestForDenial(denial({ id: 'auth-2', now: NOW + 1_000 }))

    expect(created.kind).toBe('created')
    expect(duplicate.kind).toBe('existing')
    expect(duplicate.request.id).toBe('auth-1')
    expect(repo.list()).toHaveLength(1)
  })

  test('approves once, produces an exact user turn, and marks delivery', () => {
    const repo = new MemoryRepository()
    const service = new ActionAuthorizationService(repo)
    service.requestForDenial(denial())
    service.attachPrompt('auth-1', 7200)

    const effect = service.resolve('auth-1', 'approved', NOW + 2_000)
    expect(effect.kind).toBe('approval-turn')
    expect(effect.turn).toContain('git push')
    expect(effect.request.status).toBe('delivered')
    expect(repo.get('auth-1')?.status).toBe('delivered')
  })

  test('records a reviewer denial after explicit approval without prompting again', () => {
    const repo = new MemoryRepository()
    const service = new ActionAuthorizationService(repo)
    service.requestForDenial(denial())
    service.resolve('auth-1', 'approved', NOW + 1_000)

    const contested = service.requestForDenial(denial({ id: 'auth-2', now: NOW + 2_000 }))
    const duplicate = service.requestForDenial(denial({ id: 'auth-3', now: NOW + 3_000 }))

    expect(contested.kind).toBe('reviewer-denied')
    expect(contested.request.status).toBe('reviewer-denied')
    expect(duplicate.kind).toBe('existing')
  })

  test('resolves natural replies only against the matching topic prompt', () => {
    const repo = new MemoryRepository()
    const service = new ActionAuthorizationService(repo)
    service.requestForDenial(denial())
    service.attachPrompt('auth-1', 7200)

    expect(service.requestForNaturalReply('1133', 'session-1', 'yes', 7200, NOW + 1_000)?.request.id).toBe('auth-1')
    expect(service.requestForNaturalReply('34', 'session-1', 'yes', 7200, NOW + 1_000)).toBeNull()
    expect(service.requestForNaturalReply('1133', 'session-2', 'yes', 7200, NOW + 1_000)).toBeNull()
    expect(service.requestForNaturalReply('1133', 'session-1', 'maybe', 7200, NOW + 1_000)).toBeNull()
  })

  test('does not approve an expired request', () => {
    const repo = new MemoryRepository()
    const service = new ActionAuthorizationService(repo, { ttlMs: 1_000 })
    service.requestForDenial(denial())

    expect(() => service.resolve('auth-1', 'approved', NOW + 2_000)).toThrow('already expired')
  })

  test('deduplicates against the newest matching request and prunes completed history', () => {
    const repo = new MemoryRepository()
    const service = new ActionAuthorizationService(repo, { ttlMs: 1_000 })
    service.requestForDenial(denial({ id: 'old', now: NOW - 100_000 }))
    service.requestForDenial(denial({ id: 'current', now: NOW }))

    const duplicate = service.requestForDenial(denial({ id: 'ignored', now: NOW + 100 }))
    expect(duplicate.request.id).toBe('current')
    expect(service.prune(NOW + 200_000, 50_000)).toBe(1)
    expect(service.prune(NOW + 300_000, 50_000)).toBe(1)
    expect(repo.list()).toHaveLength(0)
  })
})
