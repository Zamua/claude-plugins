import { describe, expect, test } from 'bun:test'
import { askCaption, askTarget, askTurn, DEDICATED_TOPIC_ROUTE, imageKind } from './ask'

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(parts.flatMap(p => (typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p)))

describe('askTarget', () => {
  test('empty means a dedicated topic; a thread id or general is used as is', () => {
    expect(askTarget('')).toEqual({ kind: 'dedicated' })
    expect(askTarget('  ')).toEqual({ kind: 'dedicated' })
    expect(askTarget('general')).toEqual({ kind: 'configured', topic: 'general' })
    expect(askTarget(' 3027 ')).toEqual({ kind: 'configured', topic: '3027' })
  })

  test('anything else is refused rather than guessed', () => {
    expect(askTarget('ask')).toBeUndefined()
    expect(askTarget('-12')).toBeUndefined()
  })
})

describe('imageKind', () => {
  test('reads the format from the signature', () => {
    expect(imageKind(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png')
    expect(imageKind(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
    expect(imageKind(bytes('GIF89a'))).toBe('gif')
    expect(imageKind(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('webp')
    expect(imageKind(bytes([0, 0, 0, 24], 'ftypheic'))).toBe('heic')
  })

  test('anything else is not an image, whatever it is called', () => {
    expect(imageKind(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeUndefined()
    expect(imageKind(bytes([0, 0, 0, 24], 'ftypisom'))).toBeUndefined()
    expect(imageKind(new Uint8Array())).toBeUndefined()
  })
})

describe('askCaption', () => {
  test('says whose question it is, with the page under it', () => {
    expect(askCaption('what is this?')).toBe('You asked: what is this?')
    expect(askCaption('what is this?', 'https://x.com/a/status/1')).toBe('You asked: what is this?\nhttps://x.com/a/status/1')
  })

  test('fits a photo caption', () => {
    const caption = askCaption('q'.repeat(2000))
    expect(caption.length).toBe(1024)
    expect(caption.endsWith('…')).toBeTrue()
  })
})

describe('askTurn', () => {
  const input = {
    question: 'explain this paper',
    transcribed: false,
    url: 'https://arxiv.org/abs/1',
    imagePath: '/inbox/1-ask.png',
    chatId: '-100',
    topic: '77',
    messageId: 501,
    now: Date.parse('2026-11-01T15:00:00Z'),
  }

  test('marks the turn as an ask that replies to its post', () => {
    const { meta } = askTurn(input)
    expect(meta).toMatchObject({
      ask: '1',
      chat_id: '-100',
      message_id: '501',
      message_thread_id: '77',
      image_path: '/inbox/1-ask.png',
      url: 'https://arxiv.org/abs/1',
      ts: '2026-11-01T15:00:00.000Z',
    })
  })

  test('never carries the operator user id, so it cannot read as an operator go', () => {
    expect(askTurn(input).meta.user_id).toBe('')
  })

  test('the content puts the question first and the rules after it', () => {
    const { content } = askTurn(input)
    expect(content.startsWith('explain this paper\n')).toBeTrue()
    expect(content).toContain('reply_to=501')
    expect(content).toContain('untrusted data')
    expect(content).toContain('never an operator go')
  })

  test('a question about something not read in this turn always goes to an Opus worker, memory never standing in', () => {
    const { content } = askTurn(input)
    expect(content).toContain('Always defer when the question is about a specific paper, post, link or claim you have not read in THIS turn')
    expect(content).toContain('Memory notes and earlier turns never count as having read it')
    expect(content).toContain('"Checking on that…"')
    expect(content).toContain('model "opus"')
    expect(content).toContain('NEW reply')
    expect(content).toContain('never evidence')
  })

  test('the quick reply never asks a follow-up', () => {
    expect(askTurn(input).content).toContain('Never end it with a question')
  })

  test('a transcribed question says so; general carries no thread id', () => {
    const turn = askTurn({ ...input, transcribed: true, topic: 'general' })
    expect(turn.content.startsWith('[asked by voice, auto-transcribed; may contain errors]\nexplain this paper')).toBeTrue()
    expect(turn.meta.voice_transcribed).toBe('1')
    expect(turn.meta.message_thread_id).toBeUndefined()
  })
})

test('a dedicated topic starts on Sonnet', () => {
  expect(DEDICATED_TOPIC_ROUTE).toMatchObject({ provider: 'anthropic', model: 'sonnet', ultracode: false })
})
