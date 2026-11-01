// Reminders live in the proxy, since an agent's own scheduler dies with its
// session. At fire time the proxy posts the text itself, which reaches the
// operator even if the agent cannot start, then wakes the agent for any
// follow-up it asked for.
import type { Api } from 'grammy'
import { GROUP_CHAT_ID, REMINDERS_FILE, SQUARE_TOPIC } from '../config'
import { JsonReminderRepository } from './json-reminder-repository'
import { threadOf } from '../telegram/telegram-messages'
import type { InboundMessage } from '../shared/domain/inbound-delivery'
import { InvalidReminder, LATE_AFTER_MS, dueReminders, reminderNotice, scheduleReminder } from './domain/reminder'
import type { ReminderRequest } from './domain/reminder'
import { reminderMeta } from '../shared/domain/turn-meta'
import { parseCancelReminder } from '../http/requests'
import { json } from '../http/response'
import { log, reason } from '../log'
import { openOrSetAside } from '../shared/state-file'

export type ReminderPorts = {
  api: Pick<Api, 'sendMessage'>
  /** The topics a reminder may name: waking one spawns its agent. */
  topicDirectory: () => readonly { topic: string }[]
  harnessLocked: (topic: string) => boolean
  ensureSession: (topic: string) => void
  enqueue: (topic: string, message: InboundMessage) => void
}

export function createReminders({ api, topicDirectory, harnessLocked, ensureSession, enqueue }: ReminderPorts) {
  // An agent's own scheduler dies with its session, so reminders live here. At
  // fire time the proxy posts the text itself, which reaches the operator even if
  // the agent cannot start, then wakes the agent for any follow-up it asked for.
  const reminders = openOrSetAside('reminders', REMINDERS_FILE, () => new JsonReminderRepository(REMINDERS_FILE), log)
  let firingReminders = false


  async function handleRemind(req: Request): Promise<Response> {
    const b = (await req.json()) as ReminderRequest
    const topic = String(b.topic ?? '')
    // A reminder wakes its topic, and ensureSession would spawn an agent for a
    // topic that does not exist.
    if (!topicDirectory().some(e => e.topic === topic)) return new Response(`unknown topic: ${topic}`, { status: 400 })
    try {
      const r = scheduleReminder(b, Date.now(), crypto.randomUUID().replace(/-/g, '').slice(0, 8))
      reminders.add(r)
      log(`reminder ${r.id} set for topic ${topic} at ${r.atText}`)
      return json({ id: r.id, at: r.atText })
    } catch (err) {
      if (err instanceof InvalidReminder) return new Response(err.message, { status: 400 })
      throw err
    }
  }

  function handleListReminders(url: URL): Response {
    const topic = url.searchParams.get('topic') ?? ''
    const mine = reminders
      .list()
      .filter(r => r.topic === topic)
      .sort((a, b) => a.at - b.at)
      .map(r => ({ id: r.id, at: r.atText, text: r.text, ...(r.prompt ? { prompt: r.prompt } : {}) }))
    return json({ reminders: mine })
  }

  async function handleCancelReminder(req: Request): Promise<Response> {
    const { topic, id } = parseCancelReminder(await req.json())
    const r = reminders.list().find(x => x.id === id)
    if (!r || r.topic !== topic) return new Response(`no reminder ${id} in this topic`, { status: 404 })
    reminders.remove(id)
    log(`reminder ${id} cancelled`)
    return json({ cancelled: id })
  }

  async function fireDueReminders(): Promise<void> {
    if (firingReminders) return
    firingReminders = true
    try {
      const chatId = String(GROUP_CHAT_ID)
      const now = Date.now()
      for (const r of dueReminders(reminders.list(), now)) {
        try {
          await api.sendMessage(chatId, `⏰ ${r.text}`, threadOf(r.topic))
        } catch (err) {
          log(`reminder ${r.id}: post failed, retrying next tick: ${reason(err)}`)
          continue
        }
        if (!(SQUARE_TOPIC && r.topic === SQUARE_TOPIC) && !harnessLocked(r.topic)) {
          ensureSession(r.topic)
          enqueue(r.topic, {
            content: reminderNotice(r, now),
            meta: {
              chat_id: chatId,
              user: 'telegram-topics-proxy',
              user_id: '',
              ts: new Date(now).toISOString(),
              ...(r.topic !== 'general' ? { message_thread_id: r.topic } : {}),
              ...reminderMeta(!!r.prompt),
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

  return { handleRemind, handleListReminders, handleCancelReminder, fireDueReminders }
}
