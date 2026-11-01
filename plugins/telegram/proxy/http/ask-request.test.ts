import { describe, expect, test } from 'bun:test'
import { parseAsk } from './ask-request'
import { bearerMatches } from './ask-server'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])

function form(fields: Record<string, string | Blob>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  return f
}

const on = { images: true }
const parsed = async (fields: Record<string, string | Blob>, flags = on) => (await parseAsk(form(fields), flags)).submission
const refusal = (fields: Record<string, string | Blob>) => parseAsk(form(fields), on).then(() => undefined, e => e)

describe('parseAsk', () => {
  test('takes a question, a screenshot, the page and the wait', async () => {
    const s = await parseAsk(form({ question: ' what is this? ', image: new Blob([PNG]), url: 'https://x.com/a', wait: '10' }), on)
    expect(s.image).toBe('accepted')
    expect(s.submission).toEqual({ question: 'what is this?', image: { bytes: PNG, kind: 'png' }, url: 'https://x.com/a', waitMs: 10_000 })
  })

  test('a recording stands in for the question; the question wins when both come', async () => {
    const audio = new Blob([new Uint8Array([1, 2, 3])])
    expect((await parsed({ audio })).audio).toEqual(new Uint8Array([1, 2, 3]))
    expect((await parsed({ audio, question: 'typed' })).audio).toBeUndefined()
  })

  test('a client names itself for the log, in a safe shape', async () => {
    expect((await parsed({ question: 'q', client: 'ios-app' })).client).toBe('ios-app')
    expect(await refusal({ question: 'q', client: 'two words' })).toMatchObject({ reason: 'invalid' })
  })

  test('the wait defaults, and is capped', async () => {
    expect((await parsed({ question: 'q' })).waitMs).toBe(25_000)
    expect((await parsed({ question: 'q', wait: '600' })).waitMs).toBe(50_000)
  })

  test('refuses an ask with nothing to answer, a file that is not an image, a bad url or wait', async () => {
    expect(await refusal({})).toMatchObject({ reason: 'invalid', message: 'question or audio required' })
    expect(await refusal({ question: 'q', image: new Blob(['<svg/>']) })).toMatchObject({ reason: 'invalid' })
    expect(await refusal({ question: 'q', url: 'javascript:alert(1)' })).toMatchObject({ reason: 'invalid' })
    expect(await refusal({ question: 'q', wait: 'soon' })).toMatchObject({ reason: 'invalid' })
    expect(await refusal({ question: 'q', image: 'not a file' })).toMatchObject({ reason: 'invalid' })
  })

  test('with screenshots off, one sent is ignored, unchecked, and the ask goes ahead', async () => {
    const off = await parseAsk(form({ question: 'q', image: new Blob(['<svg/>']) }), { images: false })
    expect(off.image).toBe('ignored')
    expect(off.submission.image).toBeUndefined()
    expect((await parseAsk(form({ question: 'q' }), { images: false })).image).toBe('none')
  })

  test('refuses a screenshot over the size limit', async () => {
    const big = new Uint8Array(20 * 1024 * 1024 + 1)
    big.set(PNG)
    expect(await refusal({ question: 'q', image: new Blob([big]) })).toMatchObject({ reason: 'too-large' })
  })
})

describe('bearerMatches', () => {
  test('accepts only the exact token', () => {
    expect(bearerMatches('Bearer s3cret', 's3cret')).toBeTrue()
    expect(bearerMatches('bearer s3cret', 's3cret')).toBeTrue()
    expect(bearerMatches('Bearer s3cre', 's3cret')).toBeFalse()
    expect(bearerMatches('Bearer s3cret extra', 's3cret')).toBeFalse()
    expect(bearerMatches('s3cret', 's3cret')).toBeFalse()
    expect(bearerMatches(null, 's3cret')).toBeFalse()
  })
})
