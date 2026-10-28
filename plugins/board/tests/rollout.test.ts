import { expect, test } from 'claude-code/testing'

import { CONFIG_FILE, engine, HOME, json, open, start, world } from './engine'

const NOW = Date.parse('2026-10-27T18:00:00Z')
const FILE = `${HOME}/rollout.json`
const CONFIG = { boards: [{ id: 'rollout', layout: 'rollout', path: '~/rollout.json' }] }

const ROLLOUT = {
  version: 1,
  updated_at: '2026-10-27T17:50:00Z',
  title: 'Partner rollout',
  envs: ['staging', 'prod'],
  sections: [
    {
      id: 'gates',
      title: 'Gates, in flip order',
      items: [
        { id: 'g-registry', title: 'release.funding_partner_registry', status: 'done', env: { staging: 'on', prod: 'on' } },
        { id: 'g-partner', title: 'release.order_service.partner_funding', status: 'todo', owner: 'Robin', note: 'Umbrella flag', env: { staging: 'on', prod: 'off', dev: 'on' }, after: ['g-routing'] },
        { id: 'g-routing', title: 'release.application_service.partner_bank_routing', status: 'blocked', owner: 'morgan', note: 'Needs the org list', env: { staging: '10%', prod: 'off' } },
        { id: 'g-gap', title: 'Who flips prod at 100%?', status: 'gap', note: 'Decide with Alex', detail: 'Nobody owns the **prod** flip yet.', links: [{ label: 'Thread', url: 'https://slack.com/t' }], work: 'file:partner' },
      ],
    },
    { id: 'prereqs', title: 'Prerequisites', items: [{ id: 'p1', title: 'Merge the Pav2 stack', status: 'done' }] },
  ],
}

const withRollout = () => world({ files: { [CONFIG_FILE]: json(CONFIG), [FILE]: json(ROLLOUT) } })

test('each section folds to its header and counts, showing only its gaps and blockers until pressed open', async ($, on) => {
  engine(on, withRollout(), NOW)
  await start($)

  const ui = await open($, 'rollout')
  expect(await ui.find({ key: 'rsec-gates', text: '▸ Gates, in flip order 1 gap · 1 block · 1 todo · 1 done' })).toBeDefined()
  expect(await ui.find({ key: 'ritem-g-gap', text: 'gap   Who flips prod at 100%?' })).toBeDefined()
  expect(await ui.find({ key: 'ritem-g-routing', text: 'block release.application_service.partne…' })).toBeDefined()
  expect(await ui.find({ key: 'ritem-g-partner' })).toBeUndefined()

  await ui.press({ key: 'rsec-gates' })
  expect(await ui.find({ key: 'ritem-g-partner', text: /^todo\s+release\.order_service… after relea…$/ })).toBeDefined()
  expect(await ui.find({ key: 'rrow-g-partner', text: /on\s*off$/ })).toBeDefined()
  expect(await ui.find({ key: 'renvs-gates', text: /staging\s*prod$/ })).toBeDefined()

  expect(await ui.find({ key: 'rsec-prereqs', text: '▸ Prerequisites 1 done' })).toBeDefined()
  expect(await ui.find({ key: 'ritem-p1' })).toBeUndefined()
  expect(await ui.find({ key: 'tab-rollout', text: 'rollout 1' })).toBeDefined()
  await ui.unmount()
})

test('pressing an item opens its detail, its links and a jump to its work Item', async ($, on) => {
  engine(on, withRollout(), NOW)
  await start($)

  const ui = await open($, 'rollout')
  await ui.press({ key: 'ritem-g-gap' })
  expect(await ui.find({ type: 'Text', text: 'Decide with Alex' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: 'Nobody owns the **prod** flip yet.' })).toBeDefined()
  expect(await ui.find({ key: 'rlink-g-gap-Thread', text: '↗ Thread' })).toBeDefined()
  expect(await ui.find({ key: 'rwork-g-gap', text: '↗ work: file:partner' })).toBeDefined()
  await ui.press({ key: 'ritem-g-gap' })
  expect(await ui.find({ type: 'Markdown', text: 'Nobody owns the **prod** flip yet.' })).toBeUndefined()
  await ui.unmount()
})

test('/board rollout png draws every row it shows, at the measured height', async ($, on) => {
  const w = withRollout()
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  w.files[chrome] = ''
  w.run = argv => {
    if (argv[0] === chrome && argv.includes('--dump-dom')) return { exitCode: 0, stdout: '<body data-w="500" data-h="300">', stderr: '' }
    const shot = argv.find(arg => arg.startsWith('--screenshot='))
    if (argv[0] === chrome && shot) w.files[shot.slice('--screenshot='.length)] = 'png'
    return undefined
  }
  engine(on, w, NOW)
  await start($)

  const { text } = await $.command.run({ command: 'board', args: 'rollout png', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
  expect(String(text)).toMatch(/^Saved .*board-rollout-.*\.png and copied it to the clipboard\.$/)
  expect(w.files[`${HOME}/.cache/board/export.html`]).toContain('Who flips prod at 100%?')
})
