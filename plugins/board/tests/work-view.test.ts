import { expect, test } from 'claude-code/testing'

import { CONFIG_FILE, engine, HOME, json, open, start, world } from './engine'
import { herdrHost, LIVE_CONFIG, TREE, withLive, withTree, WORK_FILE } from './work-fixtures'

const NOW = Date.parse('2026-10-27T14:00:00Z')
const session = (pane: string) => `session:herdr:default/${pane}`

test('a long title gives way so it never touches its date, and its row fills the pane to the edge', async ($, on) => {
  const items = [
    {
      id: 'long',
      title: 'A project whose title runs on far past the width the pane has room for',
      kind: 'Project',
      status: 'next',
      target: new Date(NOW + 90 * 60_000).toISOString(),
    },
  ]
  engine(on, withTree({ ...TREE, items }), NOW)
  await start($)

  const ui = await open($, 'work')
  const text = (await ui.find({ key: 'wrow-file:long' }))?.text ?? ''
  expect(text).toMatch(/^▸ next  A project whose title runs on .*… +in 2h$/)
  // The pane is 60 columns; the view keeps two clear
  expect([...text].length).toBe(58)
  await ui.unmount()
})

test('a top-level Item ends in the label of the session leading it, which brings that session to the front', async ($, on) => {
  const links = [
    { child: session('w1:p1'), parent: 'file:pay', at: '2026-10-27T13:00:00Z' },
    { child: session('w2:p1'), parent: 'file:scope', at: '2026-10-27T13:00:00Z' },
    { child: session('w2:p1'), parent: session('w1:p1'), at: '2026-10-27T13:00:00Z' },
  ]
  const host = herdrHost([
    { id: 'w1:p1', label: 'pay-lead', status: 'working', harnessId: 'h-lead' },
    { id: 'w2:p1', label: 'pay-worker', harnessId: 'h-worker' },
  ])
  const w = withLive({ ...TREE, links }, host)
  engine(on, w, NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'wlead-file:pay', text: '→ pay-lead' })).toBeDefined()
  expect(await ui.find({ key: 'wlead-file:tooling' })).toBeUndefined()

  await ui.press({ key: 'wlead-file:pay' })
  expect(w.runs).toContainEqual(['herdr', '--session', 'default', 'workspace', 'focus', 'w1'])
  await ui.unmount()
})

const DEPLOYS_FILE = `${HOME}/deploys.json`
const DEPLOYS = { updated_at: '2026-10-27T13:50:00Z', items: [{ id: 'flip', ref: 1, section: 'needs', title: 'Flip the gate' }] }
const placedConfig = { boards: [...LIVE_CONFIG.boards, { id: 'deploys', path: '~/deploys.json', under: 'pay' }] }

/** This session, harness id `s1`, sitting under `item`. */
const placedWorld = (item: string) =>
  world({
    files: {
      [CONFIG_FILE]: json(placedConfig),
      [WORK_FILE]: json({ ...TREE, links: [{ child: session('w1:p1'), parent: item, at: '2026-10-27T13:00:00Z' }] }),
      [DEPLOYS_FILE]: json(DEPLOYS),
    },
    run: herdrHost([{ id: 'w1:p1', label: 'here', harnessId: 's1' }]),
  })

test('a board placed under an Item has a tab only in the sessions working under it', async ($, on) => {
  engine(on, placedWorld('file:scope'), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'tab-deploys', text: 'deploys 1' })).toBeDefined()
  await ui.unmount()
})

test('elsewhere a placed board has no tab, and a line under its Item counts and opens it', async ($, on) => {
  engine(on, placedWorld('file:tooling'), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'tab-deploys' })).toBeUndefined()
  await ui.press({ key: 'wtoggle-file:pay' })
  expect(await ui.find({ key: 'wboardopen-deploys', text: '▤ deploys 1' })).toBeDefined()

  await ui.press({ key: 'wboardopen-deploys' })
  expect(await ui.find({ key: 'tab-deploys' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Flip the gate/ })).toBeDefined()
  await ui.unmount()
})
