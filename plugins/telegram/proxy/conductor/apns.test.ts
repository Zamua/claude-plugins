import { afterEach, describe, expect, test } from 'bun:test'
import { createPublicKey, generateKeyPairSync, verify } from 'crypto'
import http2 from 'node:http2'
import type { Http2Server, ServerHttp2Stream } from 'node:http2'
import { apnsSender, http2Transport } from './apns'
import type { ApnsReply, ApnsTransport } from './apns'

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const credentials = { keyPem, keyId: 'KEY1234567', teamId: 'TEAM123456' }
const push = { payload: { aps: { alert: { title: 't', body: 'b' } } } }

type Call = { origin: string; path: string; headers: Record<string, string>; body: string }

function recording(replies: ApnsReply[] = []): ApnsTransport & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    post: async (origin, path, headers, body) => {
      calls.push({ origin, path, headers, body })
      return replies.shift() ?? { status: 200 }
    },
    close: () => {},
  }
}

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString())

describe('the provider token', () => {
  test('is an ES256 JWT naming the key and team, verifiable with the key', async () => {
    const transport = recording()
    await apnsSender({ credentials, topic: 'app.example', transport, nowSeconds: () => 1_800_000_000 }).send('sandbox', 'ab', push)
    const [head, claims, signature] = transport.calls[0].headers.authorization.replace('bearer ', '').split('.')
    expect(decode(head)).toEqual({ alg: 'ES256', kid: 'KEY1234567' })
    expect(decode(claims)).toEqual({ iss: 'TEAM123456', iat: 1_800_000_000 })
    const ok = verify('sha256', Buffer.from(`${head}.${claims}`), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
    expect(ok).toBeTrue()
  })

  test('is reused for 50 minutes, then renewed', async () => {
    let now = 1_800_000_000
    const transport = recording()
    const sender = apnsSender({ credentials, topic: 'app.example', transport, nowSeconds: () => now })
    await sender.send('sandbox', 'ab', push)
    now += 49 * 60
    await sender.send('sandbox', 'ab', push)
    now += 60
    await sender.send('sandbox', 'ab', push)
    const tokens = transport.calls.map(c => c.headers.authorization)
    expect(tokens[1]).toBe(tokens[0])
    expect(tokens[2]).not.toBe(tokens[0])
  })

  test('an expired token is renewed and the push sent once more', async () => {
    let now = 1_800_000_000
    const transport = recording([{ status: 403, reason: 'ExpiredProviderToken' }, { status: 200 }])
    const sender = apnsSender({ credentials, topic: 'app.example', transport, nowSeconds: () => (now += 1) })
    expect(await sender.send('production', 'ab', push)).toEqual({ status: 200 })
    expect(transport.calls).toHaveLength(2)
    expect(transport.calls[1].headers.authorization).not.toBe(transport.calls[0].headers.authorization)
  })
})

test('a push goes to its environment\'s origin as an alert for the bundle, collapsing when asked', async () => {
  const transport = recording()
  const sender = apnsSender({ credentials, topic: 'app.example', transport })
  await sender.send('production', 'aabb', push)
  await sender.send('sandbox', 'ccdd', { ...push, collapseId: 'ap_1' })
  expect(transport.calls.map(c => [c.origin, c.path])).toEqual([
    ['https://api.push.apple.com', '/3/device/aabb'],
    ['https://api.sandbox.push.apple.com', '/3/device/ccdd'],
  ])
  expect(transport.calls[0].headers).toMatchObject({ 'apns-topic': 'app.example', 'apns-push-type': 'alert', 'apns-priority': '10' })
  expect(transport.calls[0].headers['apns-collapse-id']).toBeUndefined()
  expect(transport.calls[1].headers['apns-collapse-id']).toBe('ap_1')
  expect(JSON.parse(transport.calls[0].body)).toEqual(push.payload)
})

describe('the HTTP/2 transport', () => {
  let server: Http2Server | undefined
  afterEach(() => server?.close())

  async function serve(status: number, reply: string, apnsId?: string): Promise<{ origin: string; seen: Array<{ path: string; topic: string; body: string }> }> {
    const seen: Array<{ path: string; topic: string; body: string }> = []
    server = http2.createServer()
    server.on('stream', (stream: ServerHttp2Stream, headers) => {
      let body = ''
      stream.on('data', chunk => (body += chunk))
      stream.on('end', () => {
        seen.push({ path: String(headers[':path']), topic: String(headers['apns-topic']), body })
        stream.respond({ ':status': status, ...(apnsId ? { 'apns-id': apnsId } : {}) })
        stream.end(reply)
      })
    })
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    return { origin: `http://127.0.0.1:${address.port}`, seen }
  }

  test('posts over one session and reads Apple\'s reason', async () => {
    const { origin, seen } = await serve(410, '{"reason":"Unregistered","timestamp":1}')
    const transport = http2Transport()
    const headers = { 'apns-topic': 'app.example' }
    expect(await transport.post(origin, '/3/device/ab', headers, '{"x":1}')).toEqual({ status: 410, reason: 'Unregistered' })
    expect(await transport.post(origin, '/3/device/cd', headers, '{}')).toEqual({ status: 410, reason: 'Unregistered' })
    expect(seen).toEqual([
      { path: '/3/device/ab', topic: 'app.example', body: '{"x":1}' },
      { path: '/3/device/cd', topic: 'app.example', body: '{}' },
    ])
    transport.close()
  })

  test('a success has no reason', async () => {
    const { origin } = await serve(200, '')
    const transport = http2Transport()
    expect(await transport.post(origin, '/3/device/ab', {}, '{}')).toEqual({ status: 200 })
    transport.close()
  })

  test('Apple\'s id for the notification comes back with the status', async () => {
    const { origin } = await serve(200, '', '6E4D2C1B-0000-4000-8000-000000000001')
    const transport = http2Transport()
    expect(await transport.post(origin, '/3/device/ab', {}, '{}')).toEqual({ status: 200, apnsId: '6E4D2C1B-0000-4000-8000-000000000001' })
    transport.close()
  })

  test('an unreachable origin rejects', async () => {
    const transport = http2Transport()
    await expect(transport.post('http://127.0.0.1:1', '/3/device/ab', {}, '{}')).rejects.toThrow()
    transport.close()
  })
})
