import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { nodeProcessRunner } from './process-runner'

// a probe that leaves a grandchild behind, the way a CLI leaves its MCP servers
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function grandchildPid(pidFile: string): Promise<number> {
  for (let i = 0; i < 50; i++) {
    try { return Number(readFileSync(pidFile, 'utf8').trim()) } catch { await new Promise(r => setTimeout(r, 20)) }
  }
  throw new Error('grandchild never wrote its pid')
}

describe('nodeProcessRunner', () => {
  test('descendants of the command die with it', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'runner-')), 'pid')
    const result = await nodeProcessRunner('/bin/sh', ['-c', `sleep 300 & echo $! > ${pidFile}; echo started`], { cwd: '/', timeout: 5_000 })
    expect(result.stdout.trim()).toBe('started')
    const pid = await grandchildPid(pidFile)
    await new Promise(r => setTimeout(r, 200))
    const alive = pidAlive(pid)
    if (alive) process.kill(pid, 'SIGKILL')
    expect(alive).toBe(false)
  })

  test('descendants die on timeout too', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'runner-')), 'pid')
    await expect(
      nodeProcessRunner('/bin/sh', ['-c', `sleep 300 & echo $! > ${pidFile}; sleep 300`], { cwd: '/', timeout: 300 }),
    ).rejects.toThrow('timed out')
    const pid = await grandchildPid(pidFile)
    await new Promise(r => setTimeout(r, 200))
    const alive = pidAlive(pid)
    if (alive) process.kill(pid, 'SIGKILL')
    expect(alive).toBe(false)
  })
})
