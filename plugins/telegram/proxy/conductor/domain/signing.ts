// Device signatures (docs/conductor.md, "Which device"): a P-256 key the app
// keeps in the Secure Enclave, sent as the 65-byte uncompressed point.
import { createHash, createPublicKey, verify } from 'crypto'
import type { KeyObject } from 'crypto'

/** The device's public key, or undefined when the bytes are not a P-256 point. */
export function devicePublicKey(base64: string): KeyObject | undefined {
  const point = Buffer.from(base64, 'base64')
  if (point.length !== 65 || point[0] !== 4) return undefined
  try {
    return createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
      format: 'jwk',
    })
  } catch {
    return undefined
  }
}

export const sha256Hex = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

/** The bytes a write's signature covers. */
export function canonicalBytes(method: string, path: string, clientId: string, body: Uint8Array, timestamp: number): string {
  return ['v1', method, path, clientId, sha256Hex(body), String(timestamp)].join('\n')
}

export function signatureValid(key: KeyObject, canonical: string, signatureBase64: string): boolean {
  try {
    return verify('sha256', Buffer.from(canonical), { key, dsaEncoding: 'der' }, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}
