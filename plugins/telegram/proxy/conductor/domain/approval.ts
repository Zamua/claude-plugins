// An approval is a dialog a session is blocked on, as the app shows it: what
// it asks, and the numbered choices on its screen, each with the role an
// approve or deny action maps to.
export type ApprovalKind = 'permission' | 'question' | 'auth'
export type ChoiceRole = 'approve' | 'deny' | null
export type Choice = { id: string; label: string; role: ChoiceRole }
/** How it ended: a device's choice, or none (null choice and device) when the session moved on without the app. */
export type Resolution = { choice: string | null; by: string | null; at: string }

export type Approval = {
  id: string
  topic: string
  kind: ApprovalKind
  prompt: string
  choices: Choice[]
  createdAt: string
  resolved: Resolution | null
}

const OPTION = /^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s*$/

/**
 * The dialog's numbered choices: the last run of `N. label` lines on the
 * screen. A label keeps only what precedes its " · " explanation. The plain
 * "Yes" approves and the first "No" denies; the rest have no role.
 */
export function dialogChoices(screen: string): Choice[] {
  const lines = screen.split('\n')
  let end = lines.length - 1
  while (end >= 0 && !OPTION.test(lines[end])) end--
  if (end < 0) return []
  let start = end
  while (start > 0 && OPTION.test(lines[start - 1])) start--
  const choices = lines.slice(start, end + 1).map(line => {
    const [, id, raw] = line.match(OPTION) as RegExpMatchArray
    return { id, label: raw.split(' · ')[0].trim() }
  })
  const approve = choices.find(c => /^yes$/i.test(c.label))
  const deny = choices.find(c => /^no\b/i.test(c.label))
  return choices.map(c => ({ ...c, role: c === approve ? 'approve' : c === deny ? 'deny' : null }))
}

/** The question: the session's own words when it reported them, else the line above the choices. */
export function dialogPrompt(reported: string | undefined, screen: string): string {
  if (reported?.trim()) return reported.trim()
  const lines = screen.split('\n')
  const first = lines.findIndex(l => OPTION.test(l))
  for (let i = first - 1; i >= 0; i--) if (lines[i].trim()) return lines[i].trim()
  return 'The session is waiting for an answer.'
}

export function approvalKind(reported: string | null | undefined): ApprovalKind {
  return reported === 'question' || reported === 'auth' ? reported : 'permission'
}
