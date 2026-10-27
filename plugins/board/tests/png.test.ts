import { expect, test } from 'claude-code/testing'

import { board, engine, HOME, start } from './engine'
import { withTree } from './work-fixtures'

const NOW = Date.parse('2026-10-27T14:00:00Z')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const HTML = `${HOME}/.cache/board/export.html`

// Forty top-level Items: far more rows than a pane shows
const TALL = {
  version: 2,
  items: Array.from({ length: 40 }, (_, at) => ({ id: `p${at}`, title: `Project number ${at + 1}`, kind: 'Project', status: 'next' })),
  links: [],
}

test('/board work png draws every row of the view, at the height Chrome measures, to the Desktop and the clipboard', async ($, on) => {
  const w = withTree(TALL)
  w.files[CHROME] = ''
  w.run = argv => {
    if (argv[0] === CHROME && argv.includes('--dump-dom')) return { exitCode: 0, stdout: '<body data-w="540" data-h="2400">', stderr: '' }
    const shot = argv.find(arg => arg.startsWith('--screenshot='))
    if (argv[0] === CHROME && shot) w.files[shot.slice('--screenshot='.length)] = 'png'
    return undefined
  }
  engine(on, w, NOW)
  await start($)

  const said = String((await board($, 'work png')).text)
  const out = /^Saved (\S+\.png) and copied it to the clipboard\.$/.exec(said)?.[1]
  expect(out).toMatch(new RegExp(`^${HOME}/Desktop/board-work-\\d{8}-\\d{6}\\.png$`))
  expect(w.files[HTML]).toContain('Project number 1<')
  expect(w.files[HTML]).toContain('Project number 40<')

  const shot = w.runs.find(argv => argv.includes(`--screenshot=${out}`))
  expect(shot).toContain('--window-size=540,2400')
  expect(w.runs).toContainEqual(['osascript', '-e', `set the clipboard to (read (POSIX file "${out}") as «class PNGf»)`])
})

test('without Chrome, /board png says what it needs and runs nothing', async ($, on) => {
  const w = withTree(TALL)
  engine(on, w, NOW)
  await start($)

  expect((await board($, 'png')).text).toBe(`Exporting a board needs Google Chrome at ${CHROME}.`)
  expect(w.runs.some(argv => argv[0] === CHROME || argv[0] === 'osascript')).toBe(false)
})
