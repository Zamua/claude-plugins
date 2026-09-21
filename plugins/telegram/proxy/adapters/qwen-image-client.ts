import { localgenFailureFromHttp, localgenPngFromResponse } from '../domain/localgen-topic'
import type { LocalgenRequestBody } from '../domain/localgen-topic'
import { LocalgenError } from '../application/localgen-topic-service'
import type { LocalgenGeneratorPort } from '../application/localgen-ports'

// A cold prefix bucket can take 15 minutes on the card before the 40 steps run.
export const QWEN_IMAGE_TIMEOUT_MS = 30 * 60_000

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export class QwenImageClient implements LocalgenGeneratorPort {
  constructor(
    private readonly baseUrl: string,
    private readonly log: (line: string) => void = () => {},
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs: number = QWEN_IMAGE_TIMEOUT_MS,
  ) {}

  async generate(body: LocalgenRequestBody): Promise<Uint8Array> {
    const startedAt = Date.now()
    const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    this.log(`localgen request seed=${body.seed} size=${body.size} steps=${body.steps} prompt=${JSON.stringify(body.prompt.slice(0, 80))}`)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      this.log(`localgen request seed=${body.seed} failed after ${elapsed()}: ${detail}`)
      throw new LocalgenError(timedOut ? { kind: 'timeout', afterMs: this.timeoutMs } : { kind: 'down', detail })
    }
    const text = await response.text()
    if (!response.ok) {
      const failure = localgenFailureFromHttp(response.status, text)
      this.log(`localgen response seed=${body.seed} HTTP ${response.status} after ${elapsed()}: ${failure.kind}`)
      throw new LocalgenError(failure)
    }
    const png = localgenPngFromResponse(text)
    if (!(png instanceof Uint8Array)) {
      this.log(`localgen response seed=${body.seed} unreadable after ${elapsed()}: ${png.kind}`)
      throw new LocalgenError(png)
    }
    this.log(`localgen response seed=${body.seed} ${png.byteLength} bytes after ${elapsed()}`)
    return png
  }
}
