import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { deflateSync } from 'zlib'
import { sipsThumbnailer } from './thumbnails'

const crc = (bytes: Uint8Array) => {
  let c = ~0
  for (const b of bytes) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
const chunk = (type: string, data: Uint8Array) => {
  const body = Buffer.concat([Buffer.from(type), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc(body), body.length + 4)
  return out
}
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)])))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())])
}
const widthOf = (path: string) => readFileSync(path).readUInt32BE(16)

test.skipIf(!Bun.which('sips'))('a wide image is scaled to the width once; a narrow one, another type or an unreadable file is served whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'thumbs-'))
  const lines: string[] = []
  const thumbnail = sipsThumbnailer(line => void lines.push(line))
  const wide = join(dir, 'blob_wide')
  writeFileSync(wide, png(800, 400))

  const small = await thumbnail(wide, 'image/png', 200)
  expect([small, widthOf(small!)]).toEqual([`${wide}.w200`, 200])
  const made = statSync(small!).mtimeMs
  expect(await thumbnail(wide, 'image/png', 200)).toBe(small)
  expect(statSync(small!).mtimeMs).toBe(made)

  const same = await thumbnail(wide, 'image/png', 1000)
  expect(readFileSync(same!)).toEqual(readFileSync(wide))

  expect(await thumbnail(wide, 'application/pdf', 200)).toBeUndefined()
  const broken = join(dir, 'blob_broken')
  writeFileSync(broken, 'not an image')
  expect(await thumbnail(broken, 'image/png', 200)).toBeUndefined()
  expect(lines).toEqual([expect.stringMatching(/^thumbnail of .*blob_broken at 200px failed, serving the original: /)])
})
