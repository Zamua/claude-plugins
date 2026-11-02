import { expect, test } from 'bun:test'
import { ROOT, mayCreateProject, projectOf, reparentRefusal, sessionNode, sessionNodeFrom, spawnedNode, spawns, topicRole } from './session-tree'

test('general is the root; a topic recorded under a project is its worker; every other topic is a project under the root', () => {
  expect([topicRole('general'), topicRole('42')]).toEqual(['root', 'coordinator'])
  expect(sessionNode('general')).toEqual({ parent: null, spawnedBy: null, spawnedAt: null })
  expect(sessionNode('42', { parent: ROOT, spawnedBy: 'operator', spawnedAt: 't' })).toEqual({ parent: ROOT, spawnedBy: 'operator', spawnedAt: 't' })
  const worker = { parent: '43', spawnedBy: 'operator', spawnedAt: 't' }
  expect([topicRole('42', worker), sessionNode('42', worker).parent]).toEqual(['worker', '43'])
  expect(topicRole('42', { parent: '42', spawnedBy: null, spawnedAt: null })).toBe('coordinator')
  expect(spawnedNode('44', 'operator', 't')).toEqual({ parent: ROOT, spawnedBy: 'operator', spawnedAt: 't' })
})

test('a topic goes under the root or a project, never under a worker or itself, and one with workers stays a project', () => {
  const roles: Record<string, 'root' | 'coordinator' | 'worker'> = { general: 'root', p: 'coordinator', w: 'worker', t: 'coordinator' }
  const why = (topic: string, parent: string, hasWorkers = false) => reparentRefusal(topic, parent, t => roles[t], () => hasWorkers)
  expect([why('t', 'p'), why('t', ROOT), why('t', ROOT, true)]).toEqual([undefined, undefined, undefined])
  expect(why('t', 't')).toBe('a topic cannot hang under itself')
  expect(why('t', 'w')).toBe('w is a worker, not a project')
  expect(why('t', 'nope')).toBe('no project nope')
  expect(why('t', 'p', true)).toBe('t has workers of its own')
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
