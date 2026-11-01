// Narrower copies of image blobs, made by macOS `sips` and kept beside the
// original as `<blob>.w<width>`, so each width is made once.
import { existsSync, linkSync, renameSync, rmSync } from 'fs'

/** The file to serve for a blob at most `width` pixels wide: a narrower copy, or undefined for the original. */
export type Thumbnailer = (source: string, mime: string, width: number) => Promise<string | undefined>

const SCALABLE = new Set(['image/jpeg', 'image/png'])

async function sips(args: string[]): Promise<string> {
  const proc = Bun.spawn(['sips', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`sips exited ${code}: ${err.trim()}`)
  return out
}

/** Anything sips cannot read or scale is served whole, and said in the log. */
export function sipsThumbnailer(log: (line: string) => void): Thumbnailer {
  return async (source, mime, width) => {
    if (!SCALABLE.has(mime)) return undefined
    const out = `${source}.w${width}`
    if (existsSync(out)) return out
    const tmp = `${out}.${crypto.randomUUID()}.tmp`
    try {
      const own = Number((await sips(['-g', 'pixelWidth', source])).match(/pixelWidth: (\d+)/)?.[1])
      if (!own) throw new Error('no pixel width')
      // An image already narrow enough is linked, not copied, so the next request skips sips.
      if (own <= width) linkSync(source, tmp)
      else await sips(['--resampleWidth', String(width), source, '--out', tmp])
      renameSync(tmp, out)
      return out
    } catch (error) {
      rmSync(tmp, { force: true })
      log(`thumbnail of ${source} at ${width}px failed, serving the original: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
}
