import { describe, expect, test } from 'bun:test'
import { markdownV2, markdownV2Blocks } from './markdown-v2'

describe('GitHub Markdown as Telegram MarkdownV2', () => {
  test('a heading is a bold line and inline markup maps across, every special character escaped', () => {
    expect(markdownV2('## Status: v1.2 (done!)\n\nShipped **#123** in _2.5s_ with `a_b` and ~~old~~ - see 1+1=2.')).toBe(
      '*Status: v1\\.2 \\(done\\!\\)*\n\nShipped *\\#123* in _2\\.5s_ with `a_b` and ~old~ \\- see 1\\+1\\=2\\.',
    )
  })

  test('nested lists become bullet and number lines, indented by depth; tasks get boxes', () => {
    const md = [
      'Plan:',
      '',
      '1. Build the *proxy*',
      '   - add `marked`',
      '   - write tests',
      '2. Ship it',
      '',
      '- [x] merged',
      '- [ ] restarted',
    ].join('\n')
    expect(markdownV2(md)).toBe(
      [
        'Plan:',
        '',
        '1\\. Build the _proxy_',
        '    • add `marked`',
        '    • write tests',
        '2\\. Ship it',
        '',
        '☑ merged',
        '☐ restarted',
      ].join('\n'),
    )
  })

  test('a fenced code block keeps its language and only backticks and backslashes are escaped inside', () => {
    expect(markdownV2('```ts\nconst re = /a\\.b/ // `tick` (x) *y*\n```')).toBe('```ts\nconst re = /a\\\\.b/ // \\`tick\\` (x) *y*\n```')
  })

  test('a table becomes an aligned monospace block', () => {
    const md = '| PR | What | Tests |\n|---|---|--:|\n| #118 | usage file | 706 |\n| #119 | loopback `relaunch` | 710 |'
    expect(markdownV2(md)).toBe(
      [
        '```',
        'PR   │ What              │ Tests',
        '─────┼───────────────────┼──────',
        '#118 │ usage file        │   706',
        '#119 │ loopback relaunch │   710',
        '```',
      ].join('\n'),
    )
  })

  test('links keep their target, parentheses in the URL included; a relative link shows its target as text', () => {
    expect(markdownV2('See [the docs](https://en.wikipedia.org/wiki/Fork_(software)) and [notes](docs/a_b.md).')).toBe(
      'See [the docs](https://en.wikipedia.org/wiki/Fork_(software\\)) and notes \\(docs/a\\_b\\.md\\)\\.',
    )
  })

  test('a quote, a rule and a hard break render as Telegram can show them', () => {
    expect(markdownV2('> careful: this *bites*\n\n---\n\nline one  \nline two')).toBe('>careful: this _bites_\n\n──────────\n\nline one\nline two')
  })

  test('a style inside the same style is not doubled, so a bold heading with bold text stays one bold run', () => {
    expect(markdownV2('## **Status**: _really *done*_')).toBe('*Status: _really done_*')
    expect(markdownV2('*a _b_ c* and ~~x ~~y~~ z~~')).toBe('_a b c_ and ~x y z~')
  })

  test('each block keeps the Markdown it came from, for a plain fallback', () => {
    expect(markdownV2Blocks('# Title\n\nbody text\n\n- a\n- b').map(b => b.source)).toEqual(['# Title', 'body text', '- a\n- b'])
  })

  test('plain prose passes through with only its punctuation escaped', () => {
    expect(markdownV2('done. tests: 731 pass, 0 fail (typecheck clean)')).toBe('done\\. tests: 731 pass, 0 fail \\(typecheck clean\\)')
  })
})

describe('a real status message', () => {
  const status = [
    '## #119 merged',
    '',
    'Adds loopback **relaunch** and **route** for the `crook_backend`:',
    '',
    '1. `POST /topic/relaunch {topics}`',
    '   - outcome: `applied` | `queued` | `refused`',
    '   - 3 s pacing (see [broker](https://github.com/o/r/blob/main/broker.ts#L10))',
    '2. `POST /topic/route`',
    '',
    '   ```json',
    '   {"error": {"code": "needs_operator"}}',
    '   ```',
    '',
    'Checks: <710 pass>, typecheck = clean!',
  ].join('\n')

  test('renders every block, nested and fenced content included', () => {
    expect(markdownV2(status)).toBe(
      [
        '*\\#119 merged*',
        '',
        'Adds loopback *relaunch* and *route* for the `crook_backend`:',
        '',
        '1\\. `POST /topic/relaunch {topics}`',
        '    • outcome: `applied` \\| `queued` \\| `refused`',
        '    • 3 s pacing \\(see [broker](https://github.com/o/r/blob/main/broker.ts#L10)\\)',
        '2\\. `POST /topic/route`',
        '    ```json',
        '    {"error": {"code": "needs_operator"}}',
        '    ```',
        '',
        'Checks: <710 pass\\>, typecheck \\= clean\\!',
      ].join('\n'),
    )
  })
})

test('a message over one part splits between blocks, each part within the limit', async () => {
  const { messageParts } = await import('./markdown-v2')
  const para = (n: number) => `Paragraph ${n}: ${'word. '.repeat(120).trim()}`
  const text = Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n')
  const parts = messageParts(markdownV2Blocks(text), 4096)
  expect(parts.length).toBeGreaterThan(1)
  expect(parts.every(p => p.v2 !== undefined && p.v2.length <= 4096)).toBeTrue()
  expect(parts.map(p => p.source).join('\n\n')).toBe(text)
  const huge = '```\n' + 'x\n'.repeat(3000) + '```'
  const plain = messageParts(markdownV2Blocks(huge), 4096)
  expect(plain.every(p => p.v2 === undefined && p.source.length <= 4096)).toBeTrue()
})
