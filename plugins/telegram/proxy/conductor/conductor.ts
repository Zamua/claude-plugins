// Starts the conductor's listener on this machine's tailnet address, with its
// tailnet certificate, when `CONDUCTOR_LISTEN` asks for one and the identity
// policy is safe. Anything missing means no listener; the store keeps working.
import { join } from 'path'
import { createConductorApi } from './api'
import type { ConductorApiPorts } from './api'
import { policyProblem } from './domain/identity'
import type { Tailnet } from './tailscale'

/** `store-only`: the store without a listener. `tailnet:<port>`: the listener too. */
export type ListenMode = { listener: false } | { listener: true; port: number }

export function listenMode(value: string): ListenMode | undefined {
  if (value === 'store-only') return { listener: false }
  const m = value.match(/^tailnet:(\d{1,5})$/)
  const port = m ? Number(m[1]) : NaN
  return port >= 1 && port <= 65535 ? { listener: true, port } : undefined
}

const CERT_RENEW_MS = 24 * 3_600_000

export function startConductor(config: {
  mode: Extract<ListenMode, { listener: true }>
  dir: string
  operatorLogin: string
  allowedNodes: ReadonlySet<string>
  tailnet: Tailnet
  ports: Omit<ConductorApiPorts, 'policy' | 'whois'>
}): { port(): number; stop(): void } | undefined {
  const { tailnet, ports } = config
  const self = tailnet.self()
  const policy = { selfNodeId: self?.nodeId ?? '', operatorLogin: config.operatorLogin, allowedNodes: config.allowedNodes }
  const problem = policyProblem(policy)
  if (!self || problem) {
    ports.log(`conductor: not listening: ${problem ?? 'this machine is not on a tailnet'}`)
    return undefined
  }
  const certDir = join(config.dir, 'tls')
  const cert = tailnet.cert(self.dnsName, certDir)
  if (!cert) {
    ports.log('conductor: not listening: no tailnet certificate')
    return undefined
  }
  const api = createConductorApi({ ...ports, policy, whois: address => tailnet.whois(address) })
  const serve = () =>
    Bun.serve({
      hostname: self.ipv4,
      port: config.mode.port,
      tls: { cert: Bun.file(cert.certFile), key: Bun.file(cert.keyFile) },
      // Ten images of 20 MB and the text.
      maxRequestBodySize: 210 * 1024 * 1024,
      fetch: api.fetch,
      websocket: api.websocket,
    })
  let server = serve()
  ports.log(`conductor: listening on https://${self.dnsName}:${config.mode.port} (${self.ipv4})`)
  // A renewed certificate takes effect when the listener starts again on it.
  const renew = setInterval(() => {
    if (!tailnet.cert(self.dnsName, certDir)) return
    server.stop()
    server = serve()
  }, CERT_RENEW_MS)
  return {
    port: () => server.port ?? 0,
    stop() {
      clearInterval(renew)
      api.stop()
      server.stop(true)
    },
  }
}
