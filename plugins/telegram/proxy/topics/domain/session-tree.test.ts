import { expect, test } from 'bun:test'
import { ROOT, mayCreateProject, projectOf, sessionNode, sessionNodeFrom, spawnedNode, spawns, topicRole } from './session-tree'

test('general is the root; every other topic is a project, hanging under the root whoever made it', () => {
  expect([topicRole('general'), topicRole('42')]).toEqual(['root', 'coordinator'])
  expect(sessionNode('general')).toEqual({ parent: null, spawnedBy: null, spawnedAt: null })
  expect(sessionNode('42', { parent: '43', spawnedBy: '43', spawnedAt: 't' })).toEqual({ parent: ROOT, spawnedBy: '43', spawnedAt: 't' })
  expect(spawnedNode('44', 'operator', 't')).toEqual({ parent: ROOT, spawnedBy: 'operator', spawnedAt: 't' })
})

test('two levels at most: the root makes projects, a coordinator workers, a worker nothing', () => {
  expect([spawns('root'), spawns('coordinator'), spawns('worker')]).toEqual(['coordinator', 'worker', undefined])
})

test('a session\'s project: none for the root, its own for a coordinator, its coordinator\'s for a worker', () => {
  expect([projectOf('root', 'general', null), projectOf('coordinator', '42', ROOT), projectOf('worker', 'w_42_1', '42')]).toEqual([null, '42', '42'])
})

test('only the operator, the proxy and the root make projects', () => {
  expect(['operator', 'proxy', 'general', '42'].map(mayCreateProject)).toEqual([true, true, true, false])
})

test('a stored node reads back as written; anything else is no record', () => {
  expect(sessionNodeFrom({ parent: '42', spawned_by: 'operator', spawned_at: 't' })).toEqual({ parent: '42', spawnedBy: 'operator', spawnedAt: 't' })
  expect(sessionNodeFrom(null)).toBeUndefined()
})
