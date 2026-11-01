import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { canonicalBytes, devicePublicKey, signatureValid } from './signing'

const signing = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'docs', 'conductor-v1', 'signing.json'), 'utf8'))

describe('the contract\'s signing vectors', () => {
  const key = devicePublicKey(signing.public_key)!
  for (const v of signing.vectors) {
    test(`${v.name}: the canonical bytes are rebuilt exactly, and the signature ${v.valid ? 'verifies' : 'fails'}`, () => {
      expect(canonicalBytes(v.method, v.path, v.client_id, Buffer.from(v.body), v.timestamp)).toBe(v.canonical)
      expect(signatureValid(key, v.canonical, v.signature)).toBe(v.valid)
    })
  }

  const appKey = devicePublicKey(signing.app_public_key)!
  for (const v of signing.app_vectors) {
    test(`${v.name} verifies`, () => {
      expect(signatureValid(appKey, v.canonical, v.signature)).toBeTrue()
      expect(signatureValid(key, v.canonical, v.signature)).toBeFalse()
    })
  }
})

test('a public key that is not a P-256 point is refused', () => {
  expect(devicePublicKey(Buffer.alloc(65, 4).toString('base64'))).toBeUndefined()
  expect(devicePublicKey(Buffer.alloc(33, 2).toString('base64'))).toBeUndefined()
  expect(devicePublicKey('not base64 at all')).toBeUndefined()
  expect(signatureValid(devicePublicKey(signing.public_key)!, 'x', 'garbage')).toBeFalse()
})
