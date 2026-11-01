import { describe, expect, test } from 'bun:test'
import { missingConversationNotice, planRelaunch, spawnConversation } from './topic-conversation'

const mint = () => 'minted-id'

describe('spawnConversation', () => {
  test('resumes the bound conversation', () => {
    expect(spawnConversation('bound-id', mint)).toEqual({ claudeSessionId: 'bound-id', resume: true })
  })

  test('mints and starts a conversation when none is bound', () => {
    expect(spawnConversation(undefined, mint)).toEqual({ claudeSessionId: 'minted-id', resume: false })
  })
})

describe('planRelaunch', () => {
  test('a missing conversation is replaced by a new one, and both messages say so', () => {
    const plan = planRelaunch('gone-id', () => false, false)
    expect(plan.missingSessionId).toBe('gone-id')
    expect(spawnConversation(plan.claudeSessionId, mint)).toEqual({ claudeSessionId: 'minted-id', resume: false })
    expect(plan.ack).toContain('gone-id')
    expect(plan.ack).toMatch(/missing on disk.*new conversation was started/)
    expect(plan.notice).toMatch(/NEW conversation/)
    expect(plan.notice).not.toMatch(/intact/)
  })

  test('an existing conversation is kept and resumed', () => {
    const plan = planRelaunch('kept-id', id => id === 'kept-id', true)
    expect(plan.missingSessionId).toBeUndefined()
    expect(spawnConversation(plan.claudeSessionId, mint)).toEqual({ claudeSessionId: 'kept-id', resume: true })
    expect(plan.ack).toMatch(/same conversation/)
    expect(plan.notice).toMatch(/full conversation intact/)
  })

  test('a topic never spawned starts its first conversation without a disk check', () => {
    const plan = planRelaunch(undefined, () => {
      throw new Error('no bound conversation to check')
    }, false)
    expect(plan.missingSessionId).toBeUndefined()
    expect(spawnConversation(plan.claudeSessionId, mint).resume).toBe(false)
  })
})

describe('missingConversationNotice', () => {
  test('names the conversation and offers /relaunch as the way out', () => {
    const notice = missingConversationNotice('gone-id')
    expect(notice).toContain('gone-id')
    expect(notice).toMatch(/Send \/relaunch to start a fresh conversation in this topic\.$/)
  })
})
