import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Ledger, brokenLine } from './ledger'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl')

test('each act is chained to the one before, and the chain survives reopening', () => {
  const path = fresh()
  new Ledger(path).append({ kind: 'enroll', device: 'dev_1' }, '2026-11-01T20:00:00.000Z')
  new Ledger(path).append({ kind: 'message', device: 'dev_1', topic: '42' }, '2026-11-01T20:01:00.000Z')
  const lines = readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(lines.map(l => l.kind)).toEqual(['enroll', 'message'])
  expect(lines[0].prev).toBe('genesis')
  expect(lines[1].prev).toBe(lines[0].hash)
  expect(brokenLine(readFileSync(path, 'utf8'))).toBeUndefined()
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('a changed, removed or reordered line breaks the chain where it happened', () => {
  const path = fresh()
  const ledger = new Ledger(path)
  for (const topic of ['1', '2', '3']) ledger.append({ kind: 'message', topic })
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  writeFileSync(path, [lines[0], lines[1].replace('"topic":"2"', '"topic":"9"'), lines[2]].join('\n'))
  expect(brokenLine(readFileSync(path, 'utf8'))).toBe(2)
  expect(brokenLine([lines[0], lines[2]].join('\n'))).toBe(2)
  expect(brokenLine([lines[1], lines[0], lines[2]].join('\n'))).toBe(1)
})
