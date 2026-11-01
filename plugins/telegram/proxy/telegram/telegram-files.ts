import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Api } from 'grammy'

export type Downloader = (fileId: string, uniqueHint?: string) => Promise<string | null>

/** Saves a Telegram file into `inboxDir` and gives its path, or null when it cannot. */
export function telegramDownloader(
  api: Pick<Api, 'getFile'>,
  token: string,
  inboxDir: string,
  log: (m: string) => void,
): Downloader {
  return async (fileId, uniqueHint) => downloadFile(api, token, inboxDir, log, fileId, uniqueHint)
}

async function downloadFile(
  api: Pick<Api, 'getFile'>,
  token: string,
  inboxDir: string,
  log: (m: string) => void,
  fileId: string,
  uniqueHint?: string,
): Promise<string | null> {
  try {
    const file = await api.getFile(fileId)
    if (!file.file_path) return null
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
    return writeInboxFile(inboxDir, buf, ext, file.file_unique_id ?? uniqueHint ?? '')
  } catch (e) {
    log(`download failed for ${fileId}: ${e}`)
    return null
  }
}

/** Writes a file into `inboxDir` under the name every saved attachment gets, and gives its path. */
export function writeInboxFile(inboxDir: string, bytes: Uint8Array, ext: string, uid: string): string {
  // Names may come from outside, so only safe characters reach the path.
  const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const safeUid = uid.replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  mkdirSync(inboxDir, { recursive: true })
  const path = join(inboxDir, `${Date.now()}-${safeUid}.${safeExt}`)
  writeFileSync(path, bytes)
  return path
}
