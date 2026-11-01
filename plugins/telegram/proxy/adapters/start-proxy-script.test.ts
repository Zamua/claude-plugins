import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const scriptPath = join(import.meta.dir, '..', '..', 'scripts', 'start-proxy.sh')

// A copy of the plugin layout with a fake `bun` that records the state of
// node_modules it was started with, instead of installing and starting.
function plugin(nodeModules: (proxyDir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'tg-start-'))
  const bin = join(root, 'home', '.local', 'bin')
  const proxyDir = join(root, 'plugin', 'proxy')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(root, 'plugin', 'scripts'), { recursive: true })
  mkdirSync(proxyDir)
  copyFileSync(scriptPath, join(root, 'plugin', 'scripts', 'start-proxy.sh'))
  writeFileSync(join(bin, 'bun'), `#!/usr/bin/env bash
{ printf '%s\\n' "$*"; if [ -L node_modules ]; then echo link; elif [ -d node_modules ]; then echo dir; else echo none; fi; } > "$HOME/bun.called"
`)
  chmodSync(join(bin, 'bun'), 0o700)
  nodeModules(proxyDir)
  const result = spawnSync('bash', [join(root, 'plugin', 'scripts', 'start-proxy.sh')], {
    encoding: 'utf8',
    env: { HOME: join(root, 'home'), USER: 'test', PATH: '/usr/bin:/bin' },
  })
  const called = join(root, 'home', 'bun.called')
  return { result, proxyDir, bun: existsSync(called) ? readFileSync(called, 'utf8').split('\n') : [] }
}

describe('start-proxy.sh', () => {
  test('a node_modules symlink that points at itself is removed before the install', () => {
    const run = plugin(dir => symlinkSync(join(dir, 'node_modules'), join(dir, 'node_modules')))
    expect(run.bun.slice(0, 2)).toEqual(['run start', 'none'])
    expect(run.result.stderr).toContain('not a directory')
  })

  test('a file in place of node_modules is removed too', () => {
    const run = plugin(dir => writeFileSync(join(dir, 'node_modules'), 'junk'))
    expect(run.bun.slice(0, 2)).toEqual(['run start', 'none'])
  })

  test('an installed node_modules directory is left alone', () => {
    const run = plugin(dir => mkdirSync(join(dir, 'node_modules')))
    expect(run.bun.slice(0, 2)).toEqual(['run start', 'dir'])
    expect(lstatSync(join(run.proxyDir, 'node_modules')).isDirectory()).toBeTrue()
    expect(run.result.stderr).toBe('')
  })
})
