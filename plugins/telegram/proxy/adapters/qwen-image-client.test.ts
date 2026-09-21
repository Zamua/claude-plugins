import { describe, expect, test } from 'bun:test'
import { QwenImageClient } from './qwen-image-client'
import { LocalgenError } from '../application/localgen-topic-service'
import type { LocalgenRequestBody } from '../domain/localgen-topic'

const body: LocalgenRequestBody = {
  prompt: 'fox', size: '1024x1024', steps: 40, seed: 3, n: 1, response_format: 'b64_json',
}

async function failure(client: QwenImageClient) {
  try {
    await client.generate(body)
  } catch (error) {
    if (error instanceof LocalgenError) return error.failure
    throw error
  }
  throw new Error('expected a LocalgenError')
}

describe('qwen-image client', () => {
  test('POSTs the OpenAI Images body and returns the decoded PNG, logging timing', async () => {
    const lines: string[] = []
    const calls: Array<{ input: string; init: RequestInit }> = []
    const client = new QwenImageClient('http://127.0.0.1:8012', line => lines.push(line), async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('PNG').toString('base64') }] }), { status: 200 })
    })
    const png = await client.generate(body)
    expect(Buffer.from(png).toString()).toBe('PNG')
    expect(calls[0].input).toBe('http://127.0.0.1:8012/v1/images/generations')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual(body)
    expect(lines[0]).toMatch(/^localgen request seed=3 size=1024x1024 steps=40 prompt="fox"$/)
    expect(lines[1]).toMatch(/^localgen response seed=3 3 bytes after \d+\.\ds$/)
  })

  test('a refused connection maps to down', async () => {
    const client = new QwenImageClient('http://127.0.0.1:1', undefined, async () => {
      throw new Error('Unable to connect. Is the computer able to access the url?')
    })
    expect(await failure(client)).toEqual({ kind: 'down', detail: 'Unable to connect. Is the computer able to access the url?' })
  })

  test('a fetch timeout maps to timeout', async () => {
    const client = new QwenImageClient('http://127.0.0.1:1', undefined, async () => {
      const error = new Error('The operation timed out.')
      error.name = 'TimeoutError'
      throw error
    }, 5_000)
    expect(await failure(client)).toEqual({ kind: 'timeout', afterMs: 5_000 })
  })

  test('HTTP errors map through the domain classifier', async () => {
    const warming = new QwenImageClient('http://x', undefined, async () =>
      new Response(JSON.stringify({ error: { message: 'warming up' } }), { status: 503 }))
    expect(await failure(warming)).toEqual({ kind: 'warming' })
    const bad = new QwenImageClient('http://x', undefined, async () =>
      new Response(JSON.stringify({ error: { message: 'prompt must be a non-empty string' } }), { status: 400 }))
    expect(await failure(bad)).toEqual({ kind: 'http', status: 400, message: 'prompt must be a non-empty string' })
    const garbled = new QwenImageClient('http://x', undefined, async () => new Response('{}', { status: 200 }))
    expect(await failure(garbled)).toEqual({ kind: 'bad_response', detail: 'response has no data[0].b64_json' })
  })
})
