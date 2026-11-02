// Pushes each new agent or proxy message, once, to every device that gave an
// APNs token, keeps each push as sent with Apple's answer, and forgets a token
// Apple says will never work again.
import { readFileSync } from 'fs'
import { apnsSender } from './apns'
import type { ApnsReply, ApnsSender } from './apns'
import type { StoredMessage } from './domain/message'
import { captionOf, messagePush, pushable, shown } from './domain/push'
import type { ConductorStore } from './sqlite-store'
import type { Device } from './wire'

/** Ids of messages already pushed; a later event for the same message (its delivery, an edit) is not news. */
const REMEMBERED = 2000

const deadToken = (reply: ApnsReply) => reply.status === 410 || (reply.status === 400 && reply.reason === 'BadDeviceToken')

type PushPorts = {
  store: ConductorStore
  /** The topics the app lists; a message anywhere else, or in a muted one, is not pushed, nor counted in the badge. */
  topics: () => ReadonlyArray<{ id: string; name: string }>
  log: (line: string) => void
  now?: () => number
}

export type ApnsSettings = { keyFile: string; keyId: string; teamId: string; topic: string }

/** Push with the configured key, or none (said once in the log) when a setting is missing or the key unreadable. */
export function startConfiguredPush(settings: ApnsSettings, ports: PushPorts): { stop(): void } | undefined {
  const missing = Object.entries(settings).filter(([, value]) => !value).map(([name]) => name)
  if (missing.length) {
    ports.log(`push: off, missing ${missing.join(', ')}`)
    return undefined
  }
  try {
    const keyPem = readFileSync(settings.keyFile, 'utf8')
    const sender = apnsSender({ credentials: { keyPem, keyId: settings.keyId, teamId: settings.teamId }, topic: settings.topic })
    ports.log(`push: on for ${settings.topic}`)
    return startPush({ ...ports, sender })
  } catch (error) {
    ports.log(`push: off, the key cannot be used: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export function startPush(ports: PushPorts & { sender: ApnsSender }): { stop(): void } {
  const { store, sender, log } = ports
  const now = ports.now ?? Date.now
  const pushed = new Set<string>()
  let stopped = false

  /** Each topic's last pushed message with text, which a lone attachment right after it joins. */
  const lastText = new Map<string, StoredMessage>()

  async function toDevice(device: Device, message: StoredMessage, topicName: string, badge: number, caption?: StoredMessage): Promise<void> {
    if (!device.apnsToken || !device.apnsEnv) return
    const started = now()
    const route = `push: ${message.topic}#${message.seq} -> ${device.id}`
    const push = messagePush(message, topicName, badge, caption)
    const record = (answer: { reply?: ApnsReply; error?: string }) => {
      try {
        store.recordPush({
          device: device.id, topic: message.topic, kind: message.kind === 'reminder' ? 'reminder' : 'message',
          author: message.author === 'proxy' ? 'proxy' : 'agent', messageId: message.id, messageSeq: message.seq, approvalId: null,
          ...shown(push), collapseId: push.collapseId ?? null, sentAt: new Date(started).toISOString(),
          apnsStatus: answer.reply?.status ?? null, apnsReason: answer.reply?.reason ?? null, apnsId: answer.reply?.apnsId ?? null,
          error: answer.error ?? null,
        })
      } catch (error) {
        log(`${route} not recorded: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      const reply = await sender.send(device.apnsEnv, device.apnsToken, push)
      const finished = now()
      log(`${route} ${reply.status}${reply.reason ? ` ${reply.reason}` : ''} ${finished - started}ms, ${finished - Date.parse(message.at)}ms after stored`)
      record({ reply })
      if (deadToken(reply)) {
        store.dropPushToken(device.id, device.apnsToken)
        log(`push: dropped ${device.id}'s token, which Apple refused`)
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      log(`${route} failed after ${now() - started}ms: ${why}`)
      record({ error: why })
    }
  }

  store.onEvent(event => {
    if (event.type !== 'message') return
    const { message } = event
    if (stopped || pushed.has(message.id)) return
    pushed.add(message.id)
    if (pushed.size > REMEMBERED) pushed.delete(pushed.values().next().value as string)
    if (!pushable(message)) return
    const caption = captionOf(message, lastText.get(message.topic))
    if (message.text !== '') lastText.set(message.topic, message)
    try {
      const topics = ports.topics().filter(t => !store.prefs(t.id).muted)
      const topic = topics.find(t => t.id === message.topic)
      if (!topic) return
      const devices = store.pushTargets()
      if (!devices.length) return
      const badge = store.unreadIn(topics.map(t => t.id))
      for (const device of devices) void toDevice(device, message, topic.name, badge, caption)
    } catch (error) {
      log(`push: ${message.topic}#${message.seq} not sent: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  return {
    stop() {
      stopped = true
      sender.close()
    },
  }
}
