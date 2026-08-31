import { describe, expect, test } from 'bun:test'
import {
  actionFingerprint,
  actionPreview,
  approvalDecisionFromText,
  approvalTurn,
  createActionAuthorization,
  decideActionAuthorization,
  expireActionAuthorization,
  pendingAuthorizationForReply,
} from './action-authorization'

const NOW = Date.parse('2026-08-31T14:00:00Z')

function pending(over: Record<string, unknown> = {}) {
  return createActionAuthorization({
    id: 'auth-1',
    topic: '1133',
    sessionId: 'session-1',
    toolName: 'Bash',
    toolInput: {
      command: 'git push origin v1.0.0',
      description: 'Publish the reviewed release tag',
    },
    reason: 'Blocked by classifier',
    requestedAt: NOW,
    ttlMs: 15 * 60_000,
    ...over,
  })
}

describe('ActionAuthorization', () => {
  test('fingerprints the security-relevant Bash command, not presentation fields', () => {
    const first = actionFingerprint('Bash', {
      command: 'gh pr merge 6 --squash',
      description: 'Merge the approved PR',
      timeout: 60_000,
    })
    const retried = actionFingerprint('Bash', {
      command: 'gh pr merge 6 --squash',
      description: 'Retry the exact approved merge',
      timeout: 120_000,
    })
    const changed = actionFingerprint('Bash', {
      command: 'gh pr merge 7 --squash',
      description: 'Merge another PR',
    })

    expect(first).toBe(retried)
    expect(first).not.toBe(changed)
  })

  test('renders a useful preview while redacting credential values', () => {
    const preview = actionPreview('Bash', {
      command:
        'API_TOKEN=super-secret curl -H "Authorization: Bearer hidden-token" ' +
        'https://api.example.test/deploy --api-key another-secret',
      description: 'Deploy the staging service',
    })

    expect(preview.summary).toBe('Deploy the staging service')
    expect(preview.details).toContain('https://api.example.test/deploy')
    expect(preview.details).toContain('[REDACTED]')
    expect(preview.details).not.toContain('super-secret')
    expect(preview.details).not.toContain('hidden-token')
    expect(preview.details).not.toContain('another-secret')

    const request = pending({
      toolInput: {
        command: 'API_TOKEN=super-secret deploy --token hidden-token',
        description: 'Deploy with API_TOKEN=super-secret',
      },
      reason: 'Blocked command with API_TOKEN=super-secret',
    })
    expect(JSON.stringify(request)).not.toContain('super-secret')
    expect(JSON.stringify(request)).not.toContain('hidden-token')
  })

  test('recognizes natural approval and denial replies without command ids', () => {
    expect(approvalDecisionFromText('yes')).toBe('approved')
    expect(approvalDecisionFromText('Approved, please proceed')).toBe('approved')
    expect(approvalDecisionFromText('do it')).toBe('approved')
    expect(approvalDecisionFromText('no')).toBe('denied')
    expect(approvalDecisionFromText('cancel that')).toBe('denied')
    expect(approvalDecisionFromText('make it staging only')).toBeNull()
  })

  test('binds a pending request to its Telegram prompt or the sole pending topic request', () => {
    const a = { ...pending(), telegramMessageId: 7001 }
    const b = { ...pending({ id: 'auth-2', topic: '34' }), telegramMessageId: 7002 }

    expect(pendingAuthorizationForReply([a, b], '1133', 'session-1', 7001, NOW)?.id).toBe('auth-1')
    expect(pendingAuthorizationForReply([a, b], '1133', 'session-1', undefined, NOW)?.id).toBe('auth-1')
    expect(pendingAuthorizationForReply([a, b], '34', 'session-1', 7001, NOW)).toBeNull()
    expect(pendingAuthorizationForReply([a, b], '1133', 'session-2', 7001, NOW)).toBeNull()
  })

  test('refuses ambiguous bare replies when two actions are pending in one topic', () => {
    const requests = [pending(), pending({ id: 'auth-2', toolInput: { command: 'git push' } })]
    expect(pendingAuthorizationForReply(requests, '1133', 'session-1', undefined, NOW)).toBeNull()
  })

  test('allows one decision and prevents replay or decisions after expiry', () => {
    const request = pending()
    const approved = decideActionAuthorization(request, 'approved', NOW + 1_000)
    expect(approved.status).toBe('approved')
    expect(() => decideActionAuthorization(approved, 'approved', NOW + 2_000)).toThrow()

    const expired = expireActionAuthorization(request, NOW + 16 * 60_000)
    expect(expired.status).toBe('expired')
    expect(() => decideActionAuthorization(expired, 'approved', NOW + 16 * 60_000)).toThrow()
  })

  test('creates an explicit action-specific user turn for classifier re-review', () => {
    const request = pending()
    const turn = approvalTurn(request)

    expect(turn).toContain('I explicitly approve this exact action once')
    expect(turn).toContain('Publish the reviewed release tag')
    expect(turn).toContain('git push origin v1.0.0')
    expect(turn).toContain('Authorization request: auth-1')
    expect(turn).toContain(request.fingerprint.slice(0, 12))
    expect(turn).toContain('retry only this exact action')
    expect(turn).toContain('do not retry it twice')
  })
})
