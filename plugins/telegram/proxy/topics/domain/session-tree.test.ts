import { expect, test } from 'bun:test'
import { ROOT, sessionNode, sessionNodeFrom, spawnedNode } from './session-tree'

const known = (id: string) => ['general', '42', '43'].includes(id)

test('general is the root; a topic with no record hangs under it, spawner unknown', () => {
  expect(sessionNode('general')).toEqual({ parent: null, spawnedBy: null, spawnedAt: null })
  expect(sessionNode('42')).toEqual({ parent: ROOT, spawnedBy: null, spawnedAt: null })
  expect(sessionNode('general', { parent: '42', spawnedBy: 'operator', spawnedAt: 't' })).toMatchObject({ parent: null })
})

test('a topic an agent creates hangs under that agent\'s topic; the operator\'s, the proxy\'s and unknown callers\' under general', () => {
  expect(spawnedNode('44', '42', known, 't')).toEqual({ parent: '42', spawnedBy: '42', spawnedAt: 't' })
  expect(spawnedNode('44', 'operator', known, 't')).toMatchObject({ parent: ROOT, spawnedBy: 'operator' })
  expect(spawnedNode('44', 'proxy', known, 't')).toMatchObject({ parent: ROOT })
  expect(spawnedNode('44', '999', known, 't')).toMatchObject({ parent: ROOT, spawnedBy: '999' })
  expect(spawnedNode('42', '42', known, 't')).toMatchObject({ parent: ROOT })
})

test('a stored node reads back as written; anything else is no record', () => {
  expect(sessionNodeFrom({ parent: '42', spawned_by: 'operator', spawned_at: 't' })).toEqual({ parent: '42', spawnedBy: 'operator', spawnedAt: 't' })
  expect(sessionNodeFrom(null)).toBeUndefined()
  expect(sessionNodeFrom('x')).toBeUndefined()
})
