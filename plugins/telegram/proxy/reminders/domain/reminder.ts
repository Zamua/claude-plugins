import { quietNotice } from '../../topics/domain/quiet-notice'

// Reminders a topic agent schedules for itself. The proxy owns them, so they
// outlive the agent's session and fire into its topic even while it is dormant.

export type Reminder = {
  id: string
  topic: string
  // Fire time (epoch ms) and the operator-local form it was given in.
  at: number
  atText: string
  // Posted to the operator verbatim when the reminder fires.
  text: string
  // Instructions for the topic agent at fire time, never shown to the operator.
  prompt?: string
  // Nothing is posted to the operator: the agent is woken and reports to general.
  quiet?: boolean
  createdAt: number
}

export type ReminderRequest = { topic?: unknown; at?: unknown; text?: unknown; prompt?: unknown; quiet?: unknown }

export const MAX_AHEAD_MS = 366 * 86_400_000
export const LATE_AFTER_MS = 5 * 60_000
const MAX_TEXT = 1000
const MAX_PROMPT = 4000
// The zone must be explicit: the proxy's clock says nothing about where the
// operator is.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

export class InvalidReminder extends Error {}

export function scheduleReminder(req: ReminderRequest, now: number, id: string): Reminder {
  const topic = typeof req.topic === 'string' ? req.topic.trim() : ''
  if (!topic) throw new InvalidReminder('topic is required')

  const atText = typeof req.at === 'string' ? req.at.trim() : ''
  if (!ISO_WITH_ZONE.test(atText)) {
    throw new InvalidReminder('at must be an ISO 8601 time with a zone offset, e.g. 2026-10-26T09:00:00-04:00')
  }
  const at = Date.parse(atText)
  if (!Number.isFinite(at)) throw new InvalidReminder(`unparseable time: ${atText}`)
  if (at <= now) throw new InvalidReminder(`${atText} is in the past`)
  if (at - now > MAX_AHEAD_MS) throw new InvalidReminder(`${atText} is more than a year ahead`)

  const text = typeof req.text === 'string' ? req.text.trim() : ''
  if (!text || text.length > MAX_TEXT) throw new InvalidReminder(`text must be 1-${MAX_TEXT} characters`)

  const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : ''
  if (prompt.length > MAX_PROMPT) throw new InvalidReminder(`prompt must be at most ${MAX_PROMPT} characters`)

  return { id, topic, at, atText, text, ...(prompt ? { prompt } : {}), ...(req.quiet === true ? { quiet: true } : {}), createdAt: now }
}

export function dueReminders(list: Reminder[], now: number): Reminder[] {
  return list.filter(r => r.at <= now).sort((a, b) => a.at - b.at)
}

// The proxy has already posted `text` in the topic when the agent reads this, unless the reminder is quiet.
export function reminderNotice(r: Reminder, now: number): string {
  if (r.quiet) return quietNotice(`a quiet reminder scheduled for ${r.atText} is due ("${r.text}"); nothing was posted in this topic`, r.prompt)
  const lateBy = now - r.at
  const late = lateBy > LATE_AFTER_MS ? ` It fired ${Math.round(lateBy / 60_000)} min late, because the proxy was down at the scheduled time.` : ''
  const head =
    `SYSTEM NOTICE (not a user message): a reminder you scheduled for ${r.atText} is due, and the proxy ` +
    `has already posted "⏰ ${r.text}" in this topic.${late}`
  return r.prompt
    ? `${head} Your instructions for this moment: ${r.prompt} Do that now and report to the operator in this topic.`
    : `${head} No reply is required.`
}
