import { describe, expect, test } from 'bun:test'
import {
  LOCALGEN_MAX_SEED,
  localgenCaption,
  localgenFailureFromHttp,
  localgenFailureText,
  localgenPngFromResponse,
  localgenRequestBody,
  localgenTopic,
  localgenTopicFromRecord,
  parseLocalgenPrompt,
  randomLocalgenSeed,
} from './localgen-topic'

const fixedSeed = () => 7

describe('localgen topic', () => {
  test('marks the aggregate as harness-locked', () => {
    const topic = localgenTopic('9422', 'localgen', 10)
    expect(topic).toEqual({ harness: 'localgen', topic: '9422', name: 'localgen', createdAt: 10, updatedAt: 10 })
    expect(localgenTopic('9422', '  ', 10).name).toBe('9422')
    expect(() => localgenTopic(' ', 'x')).toThrow('topic id is required')
  })

  test('accepts only well-formed persisted records', () => {
    const valid = localgenTopic('9422', 'localgen', 10)
    expect(localgenTopicFromRecord(valid)).toEqual(valid)
    expect(localgenTopicFromRecord(undefined)).toBeUndefined()
    expect(localgenTopicFromRecord({ ...valid, harness: 'opencode' })).toBeUndefined()
    expect(localgenTopicFromRecord({ ...valid, topic: 9422 })).toBeUndefined()
    expect(localgenTopicFromRecord({ ...valid, updatedAt: 'x' })).toBeUndefined()
  })
})

describe('localgen prompt options', () => {
  test('defaults with a drawn seed', () => {
    expect(parseLocalgenPrompt('a red fox in snow', fixedSeed)).toEqual({
      prompt: 'a red fox in snow', size: '1024x1024', steps: 40, seed: 7, n: 1, raw: false, cache: 0,
    })
  })

  test('strips options anywhere in the text and keeps the prompt words in order', () => {
    expect(parseLocalgenPrompt('size:768x1024 a red steps:20 fox seed:5 raw n:3 in snow', fixedSeed)).toEqual({
      prompt: 'a red fox in snow', size: '768x1024', steps: 20, seed: 5, n: 3, raw: true, cache: 0,
    })
    expect(parseLocalgenPrompt('SIZE:512X512 fox RAW', fixedSeed)).toMatchObject({ size: '512x512', raw: true, prompt: 'fox' })
  })

  test('rejects an empty prompt and out-of-range options with a readable reason', () => {
    expect(parseLocalgenPrompt('steps:20', fixedSeed)).toEqual({ error: 'the prompt is empty' })
    expect(parseLocalgenPrompt('fox steps:0', fixedSeed)).toEqual({ error: 'steps must be in [1, 100]' })
    expect(parseLocalgenPrompt('fox cache:0.1', fixedSeed)).toMatchObject({ prompt: 'fox', cache: 0.1 })
    expect(parseLocalgenPrompt('fox cache:2', fixedSeed)).toEqual({ error: 'cache must be a number in [0, 1], e.g. cache:0.1' })
    expect(parseLocalgenPrompt('fox steps:101', fixedSeed)).toEqual({ error: 'steps must be in [1, 100]' })
    expect(parseLocalgenPrompt('fox n:5', fixedSeed)).toEqual({ error: 'n must be in [1, 4]' })
    expect(parseLocalgenPrompt('fox seed:-1', fixedSeed)).toEqual({ error: 'seed must be an integer' })
    expect(parseLocalgenPrompt('fox size:1024', fixedSeed)).toEqual({ error: 'size must be WxH, e.g. size:1024x1024' })
    expect(parseLocalgenPrompt(`fox seed:${LOCALGEN_MAX_SEED} n:2`, fixedSeed))
      .toEqual({ error: `seed + n - 1 must be at most ${LOCALGEN_MAX_SEED}` })
    expect(parseLocalgenPrompt(`fox seed:${LOCALGEN_MAX_SEED}`, fixedSeed)).toMatchObject({ seed: LOCALGEN_MAX_SEED })
  })

  test('random seeds leave room for n:4 inside the server range', () => {
    for (let i = 0; i < 1000; i++) {
      const seed = randomLocalgenSeed()
      expect(Number.isInteger(seed)).toBeTrue()
      expect(seed).toBeGreaterThanOrEqual(0)
      expect(seed + 3).toBeLessThanOrEqual(LOCALGEN_MAX_SEED)
    }
  })
})

describe('localgen request and caption', () => {
  test('builds one single-image b64 request per seed', () => {
    const options = parseLocalgenPrompt('fox n:2 seed:10 steps:30 size:512x512', fixedSeed)
    if ('error' in options) throw new Error(options.error)
    expect(localgenRequestBody(options, 11)).toEqual({
      prompt: 'fox', size: '512x512', steps: 30, seed: 11, n: 1, response_format: 'b64_json', cache_threshold: 0,
    })
  })

  test('caption carries seed, size, steps and m/s timing', () => {
    expect(localgenCaption(5, '1024x1024', 40, 137_400)).toBe('seed 5 · 1024x1024 · 40 steps · 2m17s')
    expect(localgenCaption(0, '512x512', 4, 900)).toBe('seed 0 · 512x512 · 4 steps · 0m1s')
  })
})

describe('localgen failure mapping', () => {
  const start = 'pm2 start qwen-image'

  test('503 warming is its own case; any other HTTP error relays error.message', () => {
    expect(localgenFailureFromHttp(503, JSON.stringify({ error: { message: 'warming up', type: 'server_busy' } })))
      .toEqual({ kind: 'warming' })
    expect(localgenFailureFromHttp(503, JSON.stringify({ error: { message: 'queue full (8 requests waiting)' } })))
      .toEqual({ kind: 'http', status: 503, message: 'queue full (8 requests waiting)' })
    expect(localgenFailureFromHttp(400, JSON.stringify({ error: { message: 'steps must be in [1, 100]' } })))
      .toEqual({ kind: 'http', status: 400, message: 'steps must be in [1, 100]' })
    expect(localgenFailureFromHttp(502, '<html>bad gateway</html>'))
      .toEqual({ kind: 'http', status: 502, message: '<html>bad gateway</html>' })
    expect(localgenFailureFromHttp(500, '')).toEqual({ kind: 'http', status: 500, message: 'HTTP 500' })
  })

  test('user-facing text names the start command only when the server is down', () => {
    expect(localgenFailureText({ kind: 'down', detail: 'ECONNREFUSED' }, start))
      .toBe(`localgen server is down. Start it from the gpu topic:\n${start}`)
    expect(localgenFailureText({ kind: 'warming' }, start)).toBe('warming up, try again in a few minutes')
    expect(localgenFailureText({ kind: 'http', status: 503, message: 'queue full' }, start))
      .toBe('localgen error (HTTP 503): queue full')
    expect(localgenFailureText({ kind: 'timeout', afterMs: 30 * 60_000 }, start))
      .toBe('generation timed out after 30 minutes')
    expect(localgenFailureText({ kind: 'bad_response', detail: 'response is not JSON' }, start))
      .toBe('localgen returned an unreadable response: response is not JSON')
  })

  test('decodes data[0].b64_json and flags anything else', () => {
    const png = localgenPngFromResponse(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from('PNG!').toString('base64'), seed: 0 }] }))
    expect(png).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(png as Uint8Array).toString()).toBe('PNG!')
    expect(localgenPngFromResponse('nope')).toEqual({ kind: 'bad_response', detail: 'response is not JSON' })
    expect(localgenPngFromResponse(JSON.stringify({ data: [{ url: '/x.png' }] })))
      .toEqual({ kind: 'bad_response', detail: 'response has no data[0].b64_json' })
  })
})
