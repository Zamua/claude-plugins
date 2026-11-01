// Who may use the conductor's API: decided from what the local Tailscale client
// says about the peer's address, never from anything the request itself carries.

/** The tailnet's answer for a peer address; null when it knows no such peer. */
export type Peer = { nodeId: string; login: string } | null

export type IdentityPolicy = {
  /** This machine's node: any local process, an agent included, reaches the API only from it. */
  selfNodeId: string
  operatorLogin: string
  /** The operator's devices; never contains `selfNodeId`. */
  allowedNodes: ReadonlySet<string>
}

export type Refusal = 'unknown_peer' | 'own_node' | 'not_operator' | 'node_not_allowed'
export type Admission = { admitted: true; nodeId: string } | { admitted: false; refusal: Refusal }

export function admit(peer: Peer, policy: IdentityPolicy): Admission {
  if (!peer) return { admitted: false, refusal: 'unknown_peer' }
  // Checked before the user: this node belongs to the operator's user too.
  if (peer.nodeId === policy.selfNodeId) return { admitted: false, refusal: 'own_node' }
  if (peer.login.toLowerCase() !== policy.operatorLogin.toLowerCase()) return { admitted: false, refusal: 'not_operator' }
  if (!policy.allowedNodes.has(peer.nodeId)) return { admitted: false, refusal: 'node_not_allowed' }
  return { admitted: true, nodeId: peer.nodeId }
}

/** A policy that would admit this machine is refused at boot, not at the first request. */
export function policyProblem(policy: IdentityPolicy): string | undefined {
  if (!policy.selfNodeId) return 'this machine\'s tailnet node is unknown'
  if (!policy.operatorLogin) return 'no operator login is configured'
  if (policy.allowedNodes.has(policy.selfNodeId)) return 'the allow-list contains this machine\'s own node'
  if (policy.allowedNodes.size === 0) return 'the allow-list is empty'
  return undefined
}
