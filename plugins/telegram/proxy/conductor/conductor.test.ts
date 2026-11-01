import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listenMode, startConductor } from './conductor'
import { Ledger } from './ledger'
import { ConductorStore } from './sqlite-store'
import type { Tailnet } from './tailscale'

test('CONDUCTOR_LISTEN is store-only or tailnet:<port>, nothing else', () => {
  expect(listenMode('store-only')).toEqual({ listener: false })
  expect(listenMode('tailnet:8793')).toEqual({ listener: true, port: 8793 })
  for (const bad of ['', 'tailnet', 'tailnet:0', 'tailnet:70000', '0.0.0.0:8793', '127.0.0.1:8793']) expect(listenMode(bad)).toBeUndefined()
})

function setup(tailnet: Partial<Tailnet>, allowedNodes = new Set(['nPHONE'])) {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-start-'))
  const logs: string[] = []
  const store = new ConductorStore(dir)
  const started = startConductor({
    mode: { listener: true, port: 0 },
    dir,
    operatorLogin: 'operator@example.com',
    allowedNodes,
    tailnet: {
      self: () => ({ nodeId: 'nSELF', dnsName: 'box.example.ts.net', ipv4: '127.0.0.1' }),
      cert: () => undefined,
      whois: async () => null,
      ...tailnet,
    },
    ports: {
      store, ledger: new Ledger(join(dir, 'ledger.jsonl')), topics: () => [], notify: () => {},
      deliver: async () => ({ delivered: true }), log: m => logs.push(m), version: 't',
    },
  })
  return { started, logs, store, dir }
}

describe('startConductor refuses to listen', () => {
  test('when the allow-list is empty or names this machine', () => {
    for (const nodes of [new Set<string>(), new Set(['nPHONE', 'nSELF'])]) {
      const { started, logs } = setup({}, nodes)
      expect(started).toBeUndefined()
      expect(logs[0]).toStartWith('conductor: not listening:')
    }
  })

  test('off a tailnet, or without a certificate', () => {
    expect(setup({ self: () => undefined }).started).toBeUndefined()
    const noCert = setup({})
    expect([noCert.started, noCert.logs]).toEqual([undefined, ['conductor: not listening: no tailnet certificate']])
  })
})

test('with a certificate it serves TLS on the tailnet address, behind the identity checks', async () => {
  const certDir = mkdtempSync(join(tmpdir(), 'conductor-cert-'))
  const certFile = join(certDir, 'cert.pem')
  const keyFile = join(certDir, 'key.pem')
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost'])
  const { started, logs } = setup({
    cert: () => ({ certFile, keyFile }),
    whois: async () => ({ nodeId: 'nPHONE', login: 'operator@example.com' }),
  })
  expect(logs.some(l => l.startsWith('conductor: listening on https://box.example.ts.net'))).toBeTrue()
  const res = await fetch(`https://127.0.0.1:${started!.port()}/v1/me`, { tls: { rejectUnauthorized: false } } as RequestInit)
  started!.stop()
  expect([res.status, (await res.json()).error.code]).toEqual([401, 'unknown_device'])
})
