import { expect, test } from 'claude-code/testing'

import { parseBoardsConfig } from '../hooks/config'

const BUILT_IN = ['session', 'prs', 'review']

test('boards sort by layout, and one placed under an Item is listed as placed', () => {
  const config = parseBoardsConfig({
    link_labels: { 'github.com': 'GH' },
    boards: [
      { id: 'oncall', path: '~/b/oncall.json' },
      { id: 'release', path: '~/b/release.json', layout: 'rollout', under: 'ship' },
      { id: 'work', path: '~/b/work.json', layout: 'model', under: 'ignored' },
    ],
  }, BUILT_IN)
  expect(config.files.map(b => b.id)).toEqual(['oncall'])
  expect(config.rollouts.map(b => b.id)).toEqual(['release'])
  expect(config.work?.id).toBe('work')
  expect(config.placed).toEqual([{ id: 'release', title: 'release', under: 'ship' }])
  expect(config.labels).toEqual({ 'github.com': 'GH' })
  expect(config.ids).toEqual([...BUILT_IN, 'oncall', 'release', 'work'])
})

test('an entry without an id or path, a reused id and a second work model are left out', () => {
  const config = parseBoardsConfig({
    boards: [
      { id: 'prs', path: '~/b/x.json' },
      { id: 'no path' },
      { id: 'bad id!', path: '~/b/y.json' },
      { id: 'a', path: '~/b/a.json' },
      { id: 'a', path: '~/b/a2.json' },
      { id: 'w1', path: '~/b/w1.json', layout: 'model' },
      { id: 'w2', path: '~/b/w2.json', layout: 'model' },
      'junk',
    ],
  }, BUILT_IN)
  expect(config.ids).toEqual([...BUILT_IN, 'a', 'w1'])
  expect(config.files.map(b => b.path)).toEqual(['~/b/a.json'])
})

test('a file that is not an object, or holds the wrong types, reads as no boards', () => {
  for (const raw of [null, [], 'text', 3]) {
    expect(parseBoardsConfig(raw, BUILT_IN)).toEqual({ labels: {}, pairs: [], files: [], rollouts: [], placed: [], ids: BUILT_IN })
  }
  const odd = parseBoardsConfig({ boards: 'x', link_labels: { a: 1, b: 'B' }, link_pairs: {} }, BUILT_IN)
  expect(odd.labels).toEqual({ b: 'B' })
  expect(odd.pairs).toEqual([])
})
