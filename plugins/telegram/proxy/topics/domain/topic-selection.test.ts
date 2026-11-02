import { expect, test } from 'bun:test'
import { topicSelection } from './topic-selection'

test('a list names its topics; * names every topic, new ones included', () => {
  const warnings: string[] = []
  const listed = topicSelection(' 34, general,x ', w => void warnings.push(w))
  expect([listed.has('34'), listed.has('general'), listed.has('35'), listed.any]).toEqual([true, true, false, true])
  expect(warnings).toEqual(['"x" is neither a thread id, general, nor *; ignored'])
  const every = topicSelection('*', () => {})
  expect([every.has('general'), every.has('99999'), every.any]).toEqual([true, true, true])
  expect(topicSelection('', () => {}).any).toBeFalse()
})
