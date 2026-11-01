import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { checkSignedWrite, replay } from './write-auth'

const signing = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'docs', 'conductor-v1', 'signing.json'), 'utf8'))
const vector = signing.vectors.find((v: { name: string }) => v.name === 'message')

const request = (over: Partial<{ clientId: string; timestamp: string; signature: string; body: string; path: string; now: number; key: string }> = {}) =>
  checkSignedWrite({
    headers: new Headers({
      'x-client-id': over.clientId ?? vector.client_id,
      'x-timestamp': over.timestamp ?? String(vector.timestamp),
      'x-signature': over.signature ?? vector.signature,
    }),
    method: vector.method,
    pathWithQuery: over.path ?? vector.path,
    body: Buffer.from(over.body ?? vector.body),
    publicKey: over.key ?? signing.public_key,
    now: over.now ?? vector.timestamp + 5_000,
  })

describe('checkSignedWrite', () => {
  test('a write signed by the device\'s key within the window is accepted, with its body hash', () => {
    expect(request()).toEqual({ clientId: vector.client_id, timestamp: vector.timestamp, signature: vector.signature, bodySha256: vector.body_sha256 })
  })

  test('the app\'s own Secure Enclave signature is accepted with its key', () => {
    const app = signing.app_vectors[0]
    expect(request({ signature: app.signature, key: signing.app_public_key })).toMatchObject({ clientId: vector.client_id })
  })

  test('a changed body or path, another device\'s key, or a missing signature is refused', () => {
    for (const r of [request({ body: '{"text":"rm -rf"}' }), request({ path: '/v1/topics/42/messages' }), request({ key: signing.app_public_key }), request({ signature: '' })]) {
      expect(r).toMatchObject({ status: 401, code: 'signature_invalid' })
    }
  })

  test('a timestamp more than 120 s off is refused before the signature is checked', () => {
    expect(request({ now: vector.timestamp + 121_000 })).toMatchObject({ status: 401, code: 'stale_timestamp' })
    expect(request({ now: vector.timestamp - 121_000 })).toMatchObject({ code: 'stale_timestamp' })
  })

  test('malformed headers are a bad request', () => {
    expect(request({ clientId: 'x' })).toMatchObject({ status: 400, code: 'bad_client_id' })
    expect(request({ timestamp: 'soon' })).toMatchObject({ status: 400, code: 'bad_timestamp' })
  })
})

describe('replay', () => {
  test('a retry with the same body gets the first answer; another body under the same id is refused', () => {
    const earlier = { bodySha256: 'abc', status: 201, response: '{"id":"m"}' }
    expect(replay(undefined, 'abc')).toBeUndefined()
    expect(replay(earlier, 'abc')).toEqual({ status: 201, response: '{"id":"m"}' })
    expect(replay(earlier, 'def')).toMatchObject({ status: 409, code: 'client_id_reused' })
  })
})
