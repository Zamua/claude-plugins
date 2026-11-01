// The local Tailscale client, as the conductor uses it: who a peer address is,
// which node this machine is, and the machine's certificate for its tailnet name.
import { execFile, spawnSync } from 'child_process'
import { chmodSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Peer } from './domain/identity'

export type TailnetSelf = { nodeId: string; dnsName: string; ipv4: string }

export type Tailnet = {
  self(): TailnetSelf | undefined
  /** Fetches or renews the certificate for `dnsName` into `dir`; undefined when it cannot. */
  cert(dnsName: string, dir: string): { certFile: string; keyFile: string } | undefined
  whois(address: string): Promise<Peer>
}

const WHOIS_CACHE_MS = 60_000

export function tailscaleCli(bin: string, log: (m: string) => void): Tailnet {
  const cache = new Map<string, { peer: Peer; until: number }>()
  return {
    self() {
      const r = spawnSync(bin, ['status', '--json'], { encoding: 'utf8', timeout: 10_000 })
      try {
        const self = JSON.parse(r.stdout).Self
        const ipv4 = (self.TailscaleIPs as string[]).find(ip => ip.includes('.'))
        if (!self.ID || !self.DNSName || !ipv4) return undefined
        return { nodeId: self.ID, dnsName: String(self.DNSName).replace(/\.$/, ''), ipv4 }
      } catch {
        log(`conductor: tailscale status failed: ${(r.stderr || r.error?.message || '').trim()}`)
        return undefined
      }
    },
    cert(dnsName, dir) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const certFile = join(dir, 'cert.pem')
      const keyFile = join(dir, 'key.pem')
      const r = spawnSync(bin, ['cert', '--cert-file', certFile, '--key-file', keyFile, dnsName], { encoding: 'utf8', timeout: 60_000 })
      if (r.status !== 0) {
        log(`conductor: tailscale cert failed: ${(r.stderr || r.error?.message || '').trim()}`)
        return undefined
      }
      chmodSync(keyFile, 0o600)
      return { certFile, keyFile }
    },
    whois(address) {
      const cached = cache.get(address)
      if (cached && cached.until > Date.now()) return Promise.resolve(cached.peer)
      return new Promise(resolve => {
        execFile(bin, ['whois', '--json', address], { timeout: 5_000 }, (error, stdout) => {
          let peer: Peer = null
          if (!error) {
            try {
              const parsed = JSON.parse(stdout)
              const nodeId = parsed?.Node?.StableID
              const login = parsed?.UserProfile?.LoginName
              if (typeof nodeId === 'string' && typeof login === 'string') peer = { nodeId, login }
            } catch {}
          }
          cache.set(address, { peer, until: Date.now() + WHOIS_CACHE_MS })
          resolve(peer)
        })
      })
    },
  }
}
