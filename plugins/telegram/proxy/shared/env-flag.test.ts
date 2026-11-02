import { describe, expect, test } from 'bun:test'
import { environmentFlag, killSwitch } from './env-flag'

describe('environmentFlag', () => {
  test('uses the default for an unset or unrecognized value', () => {
    expect(environmentFlag(undefined, true)).toBeTrue()
    expect(environmentFlag('ture', false)).toBeFalse()
  })

  test('recognizes common true and false spellings', () => {
    for (const value of ['1', 'true', 'yes', 'on', ' TRUE ']) {
      expect(environmentFlag(value, false)).toBeTrue()
    }
    for (const value of ['0', 'false', 'no', 'off', ' FALSE ']) {
      expect(environmentFlag(value, true)).toBeFalse()
    }
  })
})

describe('killSwitch', () => {
  test('unset or on stays on; off, or anything unreadable, is off and says so', () => {
    const unreadable: string[] = []
    const read = (v: string | undefined) => killSwitch(v, x => void unreadable.push(x))
    expect([undefined, '', 'on', ' TRUE '].map(read)).toEqual([true, true, true, true])
    expect(['off', 'false', 'disabled', 'of'].map(read)).toEqual([false, false, false, false])
    expect(unreadable).toEqual(['disabled', 'of'])
  })
})
