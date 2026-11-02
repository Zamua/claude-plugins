import { expect, test } from 'bun:test'
import { openCodeModelMetadata } from './opencode-model-metadata'

const listing = (id: string) => JSON.stringify({ data: [{ providerID: 'opencode-go', id, name: id, limit: { context: 400_000 }, variants: [] }] })

test('reads the model list through a private server of the installed binary, and keeps the last good answer', async () => {
  const calls: string[][] = []
  const answers: Array<string | Error> = [listing('gpt-5.6-sol'), new Error('server did not start'), '{"data": []}']
  const lines: string[] = []
  const metadata = openCodeModelMetadata({
    run: async (bin, args) => {
      calls.push([bin, ...args])
      const next = answers.shift()!
      if (next instanceof Error) throw next
      return { stdout: next, stderr: '' }
    },
    bin: '/opt/oc',
    cwd: '/',
    log: line => void lines.push(line),
  })
  expect(metadata.current().size).toBe(0)
  await metadata.refresh()
  const first = metadata.current()
  expect([...first.keys()].length).toBe(1)
  await metadata.refresh()
  await metadata.refresh()
  expect(metadata.current()).toBe(first)
  expect(calls[0]).toEqual(['/opt/oc', 'api', '--standalone', 'model.list'])
  expect(lines).toEqual(['OpenCode model metadata failed: server did not start', 'OpenCode model metadata: the answer named no models; keeping the last'])
})
