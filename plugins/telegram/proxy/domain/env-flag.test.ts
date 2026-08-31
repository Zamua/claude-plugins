import { describe, expect, test } from 'bun:test'
import { environmentFlag } from './env-flag'

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
