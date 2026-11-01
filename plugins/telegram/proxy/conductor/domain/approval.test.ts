import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { approvalKind, dialogChoices, dialogPrompt } from './approval'

// A real Claude Code permission dialog, read from an hc terminal.
const screen = readFileSync(join(import.meta.dir, 'testdata', 'permission-dialog.txt'), 'utf8')

test('the numbered choices of a real dialog, labels without their explanation, with approve and deny roles', () => {
  expect(dialogChoices(screen)).toEqual([
    { id: '1', label: 'Yes', role: 'approve' },
    { id: '2', label: 'Yes, and always allow access to /tmp/c7lab/work from this project', role: null },
    { id: '3', label: 'Yes, and switch to auto mode', role: null },
    { id: '4', label: 'No', role: 'deny' },
  ])
})

test('only the last run of numbered lines counts; a screen without one has no choices', () => {
  const twoLists = '1. an old list item\n2. another\n\nDo you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n'
  expect(dialogChoices(twoLists).map(c => [c.label, c.role])).toEqual([['Yes', 'approve'], ['No, and tell Claude what to do differently (esc)', 'deny']])
  expect(dialogChoices('thinking…')).toEqual([])
})

test('the prompt is the session\'s own words, else the line above the choices', () => {
  expect(dialogPrompt('approve Bash: touch /tmp/x', screen)).toBe('approve Bash: touch /tmp/x')
  expect(dialogPrompt(undefined, screen)).toBe('Do you want to proceed?')
  expect(dialogPrompt('', 'nothing numbered')).toBe('The session is waiting for an answer.')
})

test('a reported kind is kept when known; anything else is a permission', () => {
  expect([approvalKind('question'), approvalKind('auth'), approvalKind(null), approvalKind('weird')]).toEqual(['question', 'auth', 'permission', 'permission'])
})
