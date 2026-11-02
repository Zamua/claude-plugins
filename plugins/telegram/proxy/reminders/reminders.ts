// Reminders live in the proxy, since an agent's own scheduler dies with its
// session. At fire time the proxy posts the text itself, which reaches the
// operator even if the agent cannot start, then wakes the agent for any
// follow-up it asked for.
import type { ChatPort } from '../chat/domain/chat-port'
import { GROUP_CHAT_ID, REMINDERS_FILE, SQUARE_TOPIC } from '../config'
import { JsonReminderRepository } from './json-reminder-repository'
import type { InboundMessage } from '../shared/domain/inbound-delivery'
import { InvalidReminder, LATE_AFTER_MS, dueReminders, reminderNotice, scheduleReminder } from './domain/reminder'
import type { Reminder, ReminderRequest } from './domain/reminder'
import { QUIET_META, reminderMeta } from '../shared/domain/turn-meta'
import { parseCancelReminder } from '../http/requests'
import { json } from '../http/response'
import { log, reason } from '../log'
import { openOrSetAside } from '../shared/state-file'

export type ReminderPorts = {
  chat: Pick<ChatPort, 'send'>
  /** The topics a reminder may name: waking one spawns its agent. */
  topicDirectory: () => readonly { topic: string }[]
  harnessLocked: (topic: string) => boolean
  /** `quiet` wakes the agent without posting anything to the operator. */
  ensureSession: (topic: string, by?: 'event' | 'quiet') => void
  enqueue: (topic: string, message: InboundMessage) => void
}

export function createReminders({ chat, topicDirectory, harnessLocked, ensureSession, enqueue }: ReminderPorts) {
  // An agent's own scheduler dies with its session, so reminders live here. At
  // fire time the proxy posts the text itself, which reaches the operator even if
  // the agent cannot start, then wakes the agent for any follow-up it asked for.
  const reminders = openOrSetAside('reminders', REMINDERS_FILE, () => new JsonReminderRepository(REMINDERS_FILE), log)
  let firingReminders = false


  /** Schedules a reminder for a topic in the directory; throws InvalidReminder for anything else. */
  function addReminder(req: ReminderRequest): Reminder {
    const topic = String(req.topic ?? '')
    // A reminder wakes its topic, and ensureSession would spawn an agent for a
    // topic that does not exist.
    if (!topicDirectory().some(e => e.topic === topic)) throw new InvalidReminder(`unknown topic: ${topic}`)
    const r = scheduleReminder(req, Date.now(), crypto.randomUUID().replace(/-/g, '').slice(0, 8))
    reminders.add(r)
    log(`reminder ${r.id} set for topic ${topic} at ${r.atText}`)
    return r
  }

  /** A topic's pending reminders, soonest first. */
  const topicReminders = (topic: string): Reminder[] => reminders.list().filter(r => r.topic === topic).sort((a, b) => a.at - b.at)

  /** Cancels a reminder, in `topic` when one is named; gives it, or undefined when there is none. */
  function cancelReminder(id: string, topic?: string): Reminder | undefined {
    const r = reminders.list().find(x => x.id === id)
    if (!r || (topic !== undefined && r.topic !== topic)) return undefined
    reminders.remove(id)
    log(`reminder ${id} cancelled`)
    return r
  }

  async function handleRemind(req: Request): Promise<Response> {
    try {
      const r = addReminder((await req.json()) as ReminderRequest)
      return json({ id: r.id, at: r.atText })
    } catch (err) {
      if (err instanceof InvalidReminder) return new Response(err.message, { status: 400 })
      throw err
    }
  }

  function handleListReminders(url: URL): Response {
    const mine = topicReminders(url.searchParams.get('topic') ?? '')
      .map(r => ({ id: r.id, at: r.atText, text: r.text, ...(r.prompt ? { prompt: r.prompt } : {}) }))
    return json({ reminders: mine })
  }

  async function handleCancelReminder(req: Request): Promise<Response> {
    const { topic, id } = parseCancelReminder(await req.json())
    return cancelReminder(id, topic) ? json({ cancelled: id }) : new Response(`no reminder ${id} in this topic`, { status: 404 })
  }

  async function fireDueReminders(): Promise<void> {
    if (firingReminders) return
    firingReminders = true
    try {
      const chatId = String(GROUP_CHAT_ID)
      const now = Date.now()
      // Each post awaits Telegram, and a cancel can land meanwhile, so every step re-checks the reminder is still set
      const isSet = (id: string) => reminders.list().some(x => x.id === id)
      for (const r of dueReminders(reminders.list(), now)) {
        if (!isSet(r.id)) continue
        if (!r.quiet) {
          try {
            await chat.send(r.topic, { text: `⏰ ${r.text}` })
          } catch (err) {
            log(`reminder ${r.id}: post failed, retrying next tick: ${reason(err)}`)
            continue
          }
          if (!isSet(r.id)) {
            log(`reminder ${r.id} cancelled while posting; its agent is not woken`)
            continue
          }
        }
        if (!(SQUARE_TOPIC && r.topic === SQUARE_TOPIC) && !harnessLocked(r.topic)) {
          ensureSession(r.topic, r.quiet ? 'quiet' : 'event')
          enqueue(r.topic, {
            content: reminderNotice(r, now),
            meta: {
              chat_id: chatId,
              user: 'telegram-topics-proxy',
              user_id: '',
              ts: new Date(now).toISOString(),
              ...(r.topic !== 'general' ? { message_thread_id: r.topic } : {}),
              ...(r.quiet ? QUIET_META : reminderMeta(!!r.prompt)),
            },
          })
        }
        reminders.remove(r.id)
        log(`reminder ${r.id} fired in topic ${r.topic}${now - r.at > LATE_AFTER_MS ? ' (late)' : ''}`)
      }
    } finally {
      firingReminders = false
    }
  }

  return { handleRemind, handleListReminders, handleCancelReminder, fireDueReminders, addReminder, topicReminders, cancelReminder }
}
