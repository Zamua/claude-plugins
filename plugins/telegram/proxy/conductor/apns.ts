// Apple Push Notification service over HTTP/2 with token authentication: an
// ES256 JWT signed by the `.p8` key, one connection per environment, reused.
import { createPrivateKey, sign } from 'crypto'
import type { KeyObject } from 'crypto'
import http2 from 'node:http2'
import type { ClientHttp2Session } from 'node:http2'
import type { Push } from './domain/push'

export type ApnsEnv = 'sandbox' | 'production'

export const APNS_ORIGINS: Record<ApnsEnv, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
}

export type ApnsCredentials = { keyPem: string; keyId: string; teamId: string }

/** `apnsId` is Apple's id for the notification, from its `apns-id` header. */
export type ApnsReply = { status: number; reason?: string; apnsId?: string }

/** One POST to an APNs origin; the HTTP/2 detail stays behind it. */
export type ApnsTransport = {
  post(origin: string, path: string, headers: Record<string, string>, body: string): Promise<ApnsReply>
  close(): void
}

/** Apple refuses a token older than an hour and one renewed more than every 20 minutes. */
const TOKEN_TTL_S = 50 * 60
const REQUEST_TIMEOUT_MS = 15_000

const base64url = (bytes: Buffer | string) => Buffer.from(bytes).toString('base64url')

export function providerToken(key: KeyObject, keyId: string, teamId: string, issuedAt: number): string {
  const head = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }))
  const claims = base64url(JSON.stringify({ iss: teamId, iat: issuedAt }))
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `${head}.${claims}.${base64url(signature)}`
}

export type ApnsSender = {
  send(env: ApnsEnv, deviceToken: string, push: Push): Promise<ApnsReply>
  close(): void
}

export function apnsSender(config: {
  credentials: ApnsCredentials
  /** The app's bundle id. */
  topic: string
  transport?: ApnsTransport
  origins?: Record<ApnsEnv, string>
  nowSeconds?: () => number
}): ApnsSender {
  const key = createPrivateKey(config.credentials.keyPem)
  const transport = config.transport ?? http2Transport()
  const origins = config.origins ?? APNS_ORIGINS
  const nowSeconds = config.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  let token: { value: string; issuedAt: number } | undefined

  function bearer(renew: boolean): string {
    const now = nowSeconds()
    if (renew || !token || now - token.issuedAt >= TOKEN_TTL_S) {
      token = { value: providerToken(key, config.credentials.keyId, config.credentials.teamId, now), issuedAt: now }
    }
    return token.value
  }

  async function post(env: ApnsEnv, deviceToken: string, push: Push, renew: boolean): Promise<ApnsReply> {
    const headers: Record<string, string> = {
      authorization: `bearer ${bearer(renew)}`,
      'apns-topic': config.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
      ...(push.collapseId ? { 'apns-collapse-id': push.collapseId } : {}),
    }
    return transport.post(origins[env], `/3/device/${deviceToken}`, headers, JSON.stringify(push.payload))
  }

  return {
    async send(env, deviceToken, push) {
      const reply = await post(env, deviceToken, push, false)
      // A clock step or a long sleep can leave the cached token stale.
      return reply.status === 403 && reply.reason === 'ExpiredProviderToken' ? post(env, deviceToken, push, true) : reply
    },
    close: () => transport.close(),
  }
}

/** Keeps one session per origin and opens a new one after Apple closes it. */
export function http2Transport(): ApnsTransport {
  const sessions = new Map<string, ClientHttp2Session>()

  function session(origin: string): ClientHttp2Session {
    const open = sessions.get(origin)
    if (open && !open.closed && !open.destroyed) return open
    const created = http2.connect(origin)
    const forget = () => {
      if (sessions.get(origin) === created) sessions.delete(origin)
    }
    created.on('error', forget)
    created.on('goaway', forget)
    created.on('close', forget)
    sessions.set(origin, created)
    return created
  }

  return {
    post(origin, path, headers, body) {
      return new Promise((resolve, reject) => {
        const req = session(origin).request({ ':method': 'POST', ':path': path, ...headers })
        let status = 0
        let apnsId: string | undefined
        let text = ''
        req.setEncoding('utf8')
        req.setTimeout(REQUEST_TIMEOUT_MS, () => req.close(http2.constants.NGHTTP2_CANCEL))
        req.on('response', h => {
          status = Number(h[':status'])
          if (typeof h['apns-id'] === 'string') apnsId = h['apns-id']
        })
        req.on('data', (chunk: string) => (text += chunk))
        req.on('error', reject)
        req.on('close', () => {
          if (!status) return reject(new Error('APNs closed the stream without a response'))
          let reason: string | undefined
          try {
            reason = text ? (JSON.parse(text) as { reason?: string }).reason : undefined
          } catch {
            reason = text.slice(0, 200)
          }
          resolve({ status, ...(reason ? { reason } : {}), ...(apnsId ? { apnsId } : {}) })
        })
        req.end(body)
      })
    },
    close() {
      for (const s of sessions.values()) s.close()
      sessions.clear()
    },
  }
}
