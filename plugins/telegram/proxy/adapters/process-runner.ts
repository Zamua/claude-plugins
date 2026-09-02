import { spawn } from 'child_process'

export type ProcessResult = { stdout: string; stderr: string }
export type ProcessOptions = {
  cwd: string
  timeout: number
  env?: NodeJS.ProcessEnv
}
export type ProcessRunner = (
  binary: string,
  args: string[],
  options: ProcessOptions,
) => Promise<ProcessResult>

export const nodeProcessRunner: ProcessRunner = (binary, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.destroy()
      child.stderr.destroy()
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }
    const collect = (target: 'stdout' | 'stderr', data: Buffer) => {
      if (target === 'stdout') stdout += data.toString()
      else stderr += data.toString()
      if (stdout.length + stderr.length > 16 * 1024 * 1024) {
        child.kill('SIGTERM')
        finish(new Error(`${binary} output exceeded 16 MiB`))
      }
    }
    child.stdout.on('data', data => collect('stdout', data))
    child.stderr.on('data', data => collect('stderr', data))
    child.once('error', error => finish(error))
    // Antigravity starts a helper language-server process that can briefly
    // inherit the parent's pipe descriptors. Node's `close` event waits for
    // those descendant descriptors; the owned CLI process's `exit` is the
    // correct boundary. One event-loop turn preserves its final buffered data.
    child.once('exit', (code, signal) => {
      setTimeout(() => {
        if (code === 0) finish()
        else {
          const detail = (stderr || stdout).trim()
          finish(new Error(detail || `${binary} exited ${code ?? signal ?? 'unknown'}`))
        }
      }, 25)
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new Error(`${binary} timed out after ${options.timeout}ms`))
    }, options.timeout)
  })
