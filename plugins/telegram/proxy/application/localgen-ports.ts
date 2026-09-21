import type { LocalgenRequestBody } from '../domain/localgen-topic'

export interface LocalgenGeneratorPort {
  // Resolves with the PNG bytes; rejects with a LocalgenError.
  generate(body: LocalgenRequestBody): Promise<Uint8Array>
}

export interface LocalgenOutboundPort {
  uploading(topic: string): void
  photo(topic: string, png: Uint8Array, filename: string, caption: string, asDocument: boolean): Promise<void>
  queued(topic: string, position: number): Promise<void>
  error(topic: string, text: string): Promise<void>
}
