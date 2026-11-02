import { expect, test } from 'bun:test'
import { lifecycleOwnerFrom, ownerRefusal } from './lifecycle-owner'

const claude = { square: false, harnessLocked: false, provider: 'anthropic', conversation: true }

test('only crook reads as crook; anything else, absent included, is the proxy', () => {
  expect(['crook', 'proxy', undefined, 'Crook', 7].map(lifecycleOwnerFrom)).toEqual(['crook', 'proxy', 'proxy', 'proxy', 'proxy'])
})

test('the backend takes an existing Claude conversation on an Anthropic route, nothing else', () => {
  expect(ownerRefusal('crook', claude)).toBeUndefined()
  expect(ownerRefusal('crook', { ...claude, square: true })).toBe('the square has no session')
  expect(ownerRefusal('crook', { ...claude, harnessLocked: true })).toBe('locked to another harness, which only the proxy runs')
  expect(ownerRefusal('crook', { ...claude, conversation: false })).toBe('no conversation yet; the proxy starts it first')
  expect(ownerRefusal('crook', { ...claude, provider: 'codex' })).toBe('on a codex route, which the Crook backend cannot run')
})

test('any topic can come back to the proxy', () => {
  expect(ownerRefusal('proxy', { square: true, harnessLocked: true, provider: 'codex', conversation: false })).toBeUndefined()
})
