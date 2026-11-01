// Whether a write really comes from an enrolled device (docs/conductor.md,
// "Which device"): its signature over the canonical bytes, a timestamp near now,
// and a client id that names one request. Retries reuse the client id with the
// same body and get the first answer; a different body under it is refused.
import { canonicalBytes, devicePublicKey, sha256Hex, signatureValid } from './signing'

export const SKEW_MS = 120_000

export type SignedWrite = { clientId: string; timestamp: number; signature: string; bodySha256: string }

export type WriteRefusal = { status: 400 | 401 | 409; code: string; message: string }

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/

/** The signed write, or why it is refused. `publicKey` is the device's enrolled key. */
export function checkSignedWrite(input: {
  headers: Headers
  method: string
  pathWithQuery: string
  body: Uint8Array
  publicKey: string
  now: number
}): SignedWrite | WriteRefusal {
  const clientId = input.headers.get('x-client-id') ?? ''
  const timestampText = input.headers.get('x-timestamp') ?? ''
  const signature = input.headers.get('x-signature') ?? ''
  if (!CLIENT_ID.test(clientId)) return { status: 400, code: 'bad_client_id', message: 'X-Client-Id must be 8 to 64 of A-Z a-z 0-9 _ -' }
  if (!/^\d{10,16}$/.test(timestampText)) return { status: 400, code: 'bad_timestamp', message: 'X-Timestamp must be Unix milliseconds' }
  const timestamp = Number(timestampText)
  if (Math.abs(input.now - timestamp) > SKEW_MS) return { status: 401, code: 'stale_timestamp', message: 'X-Timestamp is more than 120 s off' }
  const key = devicePublicKey(input.publicKey)
  const canonical = canonicalBytes(input.method, input.pathWithQuery, clientId, input.body, timestamp)
  if (!key || !signature || !signatureValid(key, canonical, signature)) {
    return { status: 401, code: 'signature_invalid', message: 'the request signature does not verify' }
  }
  return { clientId, timestamp, signature, bodySha256: sha256Hex(input.body) }
}

export type EarlierWrite = { bodySha256: string; status: number; response: string }

/** A client id seen before: the same body is a retry and gets the first answer; another body is refused. */
export function replay(earlier: EarlierWrite | undefined, bodySha256: string): { status: number; response: string } | WriteRefusal | undefined {
  if (!earlier) return undefined
  if (earlier.bodySha256 !== bodySha256) {
    return { status: 409, code: 'client_id_reused', message: 'this client id was used for another request' }
  }
  return { status: earlier.status, response: earlier.response }
}
