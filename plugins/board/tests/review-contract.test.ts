import { expect, test } from 'claude-code/testing'

import { engine, HOME, json, PANE, start, world } from './engine'
import { EXAMPLE } from './review-board.example'

// pr-review-board writes the review board and this plugin draws it; they meet only
// at the file. The fixture is the example board from pr-review-board's review rules
// with one comment per severity its checker accepts, and pr-review-board's
// tests/test_board_contract.sh holds it to both.
const NOW = Date.parse('2026-10-21T14:00:00Z')
const SESSION = 'sess-hand'
const MANUAL_FILE = `${HOME}/workspace/reviews/.pr-review-board/manual-${SESSION}/board.json`

test('the documented review board draws: title, verdict, every pull request, and each comment in its severity', async ($, on) => {
  engine(on, world({ session: { id: SESSION }, files: { [MANUAL_FILE]: json(EXAMPLE) } }), NOW)
  await start($)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 80 }, surface: 'terminal' })

  expect(await ui.find({ key: 'title-row', text: new RegExp(`${EXAMPLE.title}\\s*${EXAMPLE.verdict}`) })).toBeDefined()
  for (const p of EXAMPLE.prs) expect([p.pr, await ui.find({ key: `prrow-${p.pr}` })]).toEqual([p.pr, expect.anything()])
  for (const c of EXAMPLE.comments) {
    const shown = await ui.find({ key: `section-${c.severity}`, text: new RegExp(c.summary.slice(0, 24)) })
    expect([c.severity, shown]).toEqual([c.severity, expect.anything()])
  }
  await ui.unmount()
})
