// Opens an approval while a session is blocked on a dialog, and resolves it as
// expired once the session moves on without the app (someone answered at the
// desktop, or the dialog went away). Read side only: nothing here answers.
import { approvalKind, dialogChoices, dialogPrompt } from './domain/approval'
import type { ConductorStore } from './sqlite-store'

/** A dialog drawn after the session reports blocked may not be on screen yet; wait this long for its choices. */
const DRAW_GRACE_MS = 5_000

export type ApprovalPorts = {
  store: Pick<ConductorStore, 'openApprovals' | 'openApproval' | 'resolveApproval'>
  topics: () => ReadonlyArray<{ id: string }>
  /** What a topic's session says it is blocked on; undefined when it is not blocked. */
  blocked: (topic: string) => { kind: string | null; msg: string } | undefined
  screen: (topic: string) => Promise<string | undefined>
  log: (line: string) => void
  now?: () => number
}

export function trackApprovals(ports: ApprovalPorts) {
  const { store, log } = ports
  const now = ports.now ?? Date.now
  const reading = new Set<string>()
  const blockedSince = new Map<string, number>()

  async function open(topic: string, dialog: { kind: string | null; msg: string }): Promise<void> {
    reading.add(topic)
    try {
      const screen = (await ports.screen(topic)) ?? ''
      const still = ports.blocked(topic)
      if (!still || still.msg !== dialog.msg || store.openApprovals(topic).length) return
      const choices = dialogChoices(screen)
      if (!choices.length && now() - (blockedSince.get(topic) ?? now()) < DRAW_GRACE_MS) return
      const approval = store.openApproval({ topic, kind: approvalKind(dialog.kind), prompt: dialogPrompt(dialog.msg, screen), choices })
      log(`conductor: approval ${approval.id} open in topic ${topic} (${approval.kind}, ${choices.length} choices)`)
    } finally {
      reading.delete(topic)
    }
  }

  /** Brings every topic's approval in line with whether, and on what, its session is blocked. */
  async function check(): Promise<void> {
    const at = new Date(now()).toISOString()
    const work: Promise<void>[] = []
    for (const { id: topic } of ports.topics()) {
      const dialog = ports.blocked(topic)
      if (!dialog) blockedSince.delete(topic)
      else if (!blockedSince.has(topic)) blockedSince.set(topic, now())
      for (const stale of store.openApprovals(topic)) {
        // Unblocked, or blocked on another dialog: the one the app saw is over.
        if (dialog && (stale.prompt === dialogPrompt(dialog.msg, '') || !dialog.msg)) continue
        store.resolveApproval(stale.id, { choice: null, by: null, at })
        log(`conductor: approval ${stale.id} in topic ${topic} expired (the session moved on)`)
      }
      if (dialog && !store.openApprovals(topic).length && !reading.has(topic)) work.push(open(topic, dialog))
    }
    await Promise.all(work)
  }

  return { check }
}
