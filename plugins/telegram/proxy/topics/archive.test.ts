import { afterEach, expect, test } from 'bun:test'
import { createTopicArchive } from './archive'
import { getTopic, topics } from './state'
import type { TopicState } from './state'

const ids = ['a1', 'a2', 'general', 'sq']
afterEach(() => ids.forEach(id => topics.delete(id)))

function setup() {
  for (const id of ids) getTopic(id)
  getTopic('a1').claudeSessionId = 'conv-1'
  const killed: string[] = []
  const renamed: Array<[string, string]> = []
  let saves = 0
  const archive = createTopicArchive({
    killSession: (_st: TopicState, topic: string) => (killed.push(topic), topic === 'a1'),
    save: () => void saves++,
    rename: async (topic, name) => {
      renamed.push([topic, name])
      getTopic(topic).name = name
    },
    square: 'sq',
    now: () => new Date('2026-11-02T01:00:00.000Z'),
    log: () => {},
  })
  return { archive, killed, renamed, saves: () => saves }
}

test('archiving stops the session and keeps the conversation; again is a no-op', () => {
  const { archive, killed, saves } = setup()
  expect(archive.archive(['a1', 'a1', 'a2'])).toEqual([{ topic: 'a1', outcome: 'archived' }, { topic: 'a2', outcome: 'archived' }])
  expect([killed, saves(), getTopic('a1').archivedAt, getTopic('a1').claudeSessionId]).toEqual([['a1', 'a2'], 1, '2026-11-02T01:00:00.000Z', 'conv-1'])
  expect(archive.archive(['a1'])).toEqual([{ topic: 'a1', outcome: 'already_archived' }])
  expect([killed.length, saves()]).toEqual([2, 1])
})

test('only projects can be archived: the root, the square and unknown topics are not', () => {
  const { archive, killed } = setup()
  expect(archive.archive(['general', 'sq', 'nope'])).toEqual([
    { topic: 'general', outcome: 'refused', reason: 'general is the root, not a project' },
    { topic: 'sq', outcome: 'refused', reason: 'the square is not a project' },
    { topic: 'nope', outcome: 'unknown' },
  ])
  expect(killed).toEqual([])
})

test('restoring clears the flag and nothing else; a topic not archived is left as it is', () => {
  const { archive, killed, saves } = setup()
  archive.archive(['a1'])
  expect(archive.restore(['a1', 'a2'])).toEqual([{ topic: 'a1', outcome: 'restored' }, { topic: 'a2', outcome: 'not_archived' }])
  expect([getTopic('a1').archivedAt, getTopic('a1').claudeSessionId, killed, saves()]).toEqual([undefined, 'conv-1', ['a1'], 2])
})

test('a rename to the current name changes nothing', async () => {
  const { archive, renamed } = setup()
  expect(await archive.rename('a1', 'build')).toEqual({ topic: 'a1', outcome: 'renamed' })
  expect(await archive.rename('a1', 'build')).toEqual({ topic: 'a1', outcome: 'unchanged' })
  expect(await archive.rename('general', 'x')).toMatchObject({ outcome: 'refused' })
  expect(renamed).toEqual([['a1', 'build']])
})
