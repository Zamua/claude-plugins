// Secrets dropped into a topic with /secret: stored to the secrets directory,
// deleted from the chat, and never enqueued, so no transcript holds a value.
import type { Api } from 'grammy'
import { join } from 'path'
import { SECRETS_DIR, SECRETS_USER_ID, SQUARE_TOPIC } from '../config'
import { threadOf } from '../telegram/telegram-messages'
import type { InboundMessage } from '../shared/domain/inbound-delivery'
import { SECRET_DROP_META } from '../shared/domain/turn-meta'
import { log, noticeFailed, reason, tilde } from '../log'
import {
  advanceSecretFlow,
  beginSecretFlow,
  deleteSecret,
  listSecrets,
  parseSecretCommand,
  secretExists,
  SecretExists,
  SecretMissing,
  storeSecret,
} from './secret'
import type { FlowResult, Pending } from './secret'

export type SecretDropPorts = {
  api: Pick<Api, 'sendMessage' | 'deleteMessage'>
  sayIn: (chatId: string, topic: string, text: string) => Promise<unknown>
  harnessLocked: (topic: string) => boolean
  ensureSession: (topic: string) => void
  enqueue: (topic: string, message: InboundMessage) => void
}

export function createSecretDrop({ api, sayIn, harnessLocked, ensureSession, enqueue }: SecretDropPorts) {
  // A "/secret <name>" message is stored to SECRETS_DIR and deleted from the
  // chat without ever being enqueued: a topic-Claude's transcript persists every
  // inbound message in plaintext, so the value must not reach one. The ack names
  // the path and the byte count, never the value, and it is the whole notice: a
  // Claude is not woken or told, it reads the file when asked to use it.
  async function handleSecretDrop(
    chatId: string, topic: string, msgId: number, fromId: string, text: string,
  ): Promise<void> {
    const say = (t: string) =>
      api.sendMessage(chatId, t, threadOf(topic)).catch(noticeFailed('secret notice', topic))
    // Delete before validating: a refused name must not leave the value on screen.
    let deleted = true
    try {
      await api.deleteMessage(chatId, msgId)
    } catch {
      deleted = false
    }
    const undeleted = deleted ? '' : ' Could NOT delete your message; remove it yourself.'
    if (!SECRETS_USER_ID || fromId !== SECRETS_USER_ID) {
      log(`secret drop refused from user ${fromId}`)
      await say(`🔐 refused: not the secrets user.${undeleted}`)
      return
    }
    const cmd = parseSecretCommand(text)
    if ('error' in cmd) {
      await say(`🔐 ${cmd.error}.${undeleted}`)
      return
    }
    if (cmd.kind === 'begin') {
      // A menu tap sends the bare verb, so a bare verb opens the guided flow.
      await cancelSecretFlow(chatId, fromId, topic)
      await promptSecret(chatId, topic, fromId, beginSecretFlow(cmd.verb), [])
      return
    }
    if (cmd.kind === 'list') {
      const entries = listSecrets(SECRETS_DIR)
      let body = entries.map(e => `${e.name}  ${e.bytes} bytes  ${e.mtime.toISOString().slice(0, 10)}`).join('\n')
      if (body.length > 3500) body = body.slice(0, 3500) + '\n... truncated'
      await say(`🔐 ${tilde(SECRETS_DIR)}: ${entries.length} secret(s)\n${body}${undeleted}`)
      return
    }
    if (cmd.kind === 'delete') {
      await deleteAndAck(chatId, topic, fromId, cmd.name, undeleted)
      return
    }
    await storeAndAck(chatId, topic, fromId, cmd.name, cmd.value, cmd.replace, undeleted)
  }

  // ---- guided flow -------------------------------------------------------------
  // A bare /secret or /unsecret opens a prompt exchange (name, then value). The
  // state is keyed by user AND topic and expires, so a stale flow can never
  // swallow an unrelated message. Every message in the exchange is deleted and
  // only the final ack stays.

  type PendingFlow = { pending: Pending; prompts: number[]; at: number }
  const pendingSecrets = new Map<string, PendingFlow>()
  const SECRET_FLOW_TTL_MS = 5 * 60_000
  const flowKey = (fromId: string, topic: string) => `${fromId}:${topic}`

  function pendingSecretFlow(fromId: string, topic: string): PendingFlow | undefined {
    const key = flowKey(fromId, topic)
    const flow = pendingSecrets.get(key)
    if (!flow) return undefined
    if (Date.now() - flow.at > SECRET_FLOW_TTL_MS) {
      pendingSecrets.delete(key)
      return undefined
    }
    return flow
  }

  // ForceReply opens the reply box on the phone with the placeholder shown.
  async function promptSecret(
    chatId: string, topic: string, fromId: string, result: FlowResult, prompts: number[],
  ): Promise<void> {
    if (result.kind !== 'prompt') return
    const sent = await api
      .sendMessage(chatId, result.text, {
        ...threadOf(topic),
        reply_markup: { force_reply: true, input_field_placeholder: result.placeholder },
      })
      .catch(() => null)
    if (sent) prompts.push(sent.message_id)
    pendingSecrets.set(flowKey(fromId, topic), { pending: result.next, prompts, at: Date.now() })
  }

  async function cancelSecretFlow(chatId: string, fromId: string, topic: string): Promise<void> {
    const key = flowKey(fromId, topic)
    const flow = pendingSecrets.get(key)
    if (!flow) return
    pendingSecrets.delete(key)
    await deleteMessages(chatId, flow.prompts)
  }

  async function deleteMessages(chatId: string, ids: number[]): Promise<void> {
    for (const id of ids) await api.deleteMessage(chatId, id).catch(() => {})
  }

  // One step of the flow. The user's message is deleted first whatever it holds.
  async function handleSecretStep(
    chatId: string, topic: string, msgId: number, fromId: string, text: string, flow: PendingFlow,
  ): Promise<void> {
    pendingSecrets.delete(flowKey(fromId, topic))
    let deleted = true
    try {
      await api.deleteMessage(chatId, msgId)
    } catch {
      deleted = false
    }
    const undeleted = deleted ? '' : ' Could NOT delete your message; remove it yourself.'
    const r = advanceSecretFlow(flow.pending, text, name => secretExists(SECRETS_DIR, name))
    if (r.kind === 'prompt') {
      await promptSecret(chatId, topic, fromId, r, flow.prompts)
      return
    }
    await deleteMessages(chatId, flow.prompts)
    if (r.kind === 'cancelled') {
      await sayIn(chatId, topic, `🔐 cancelled.${undeleted}`)
      return
    }
    if (r.kind === 'delete') {
      await deleteAndAck(chatId, topic, fromId, r.name, undeleted)
      return
    }
    await storeAndAck(chatId, topic, fromId, r.name, r.value, r.replace, undeleted)
  }

  async function storeAndAck(
    chatId: string, topic: string, fromId: string, name: string, value: string, replace: boolean, undeleted: string,
  ): Promise<void> {
    const shown = tilde(join(SECRETS_DIR, name))
    let stored
    try {
      stored = storeSecret(SECRETS_DIR, name, value, replace)
    } catch (err) {
      if (err instanceof SecretExists) {
        log(`secret drop refused: ${shown} exists`)
        await sayIn(
          chatId, topic,
          `🔐 refused: ${shown} exists (${err.bytes} bytes). Resend as /secret ${name} --replace to overwrite it.${undeleted}`,
        )
        return
      }
      log(`secret drop failed for ${name}: ${err}`)
      await sayIn(chatId, topic, `🔐 could not store "${name}": ${reason(err)}.${undeleted}`)
      return
    }
    const note = `${stored.replaced ? 'replaced' : 'stored'} ${shown} (${stored.bytes} bytes)`
    log(`secret drop: ${note}`)
    await sayIn(chatId, topic, `🔐 ${note}.${undeleted}`)
    notifyTopic(chatId, topic, fromId, `the operator ${note}. Read the file when a task needs it; the value was deliberately never sent to you.`)
  }

  async function deleteAndAck(
    chatId: string, topic: string, fromId: string, name: string, undeleted: string,
  ): Promise<void> {
    const shown = tilde(join(SECRETS_DIR, name))
    try {
      const gone = deleteSecret(SECRETS_DIR, name)
      log(`secret drop: deleted ${shown}`)
      await sayIn(chatId, topic, `🔐 deleted ${shown} (${gone.bytes} bytes).${undeleted}`)
      notifyTopic(chatId, topic, fromId, `the operator deleted the secret ${shown}.`)
    } catch (err) {
      const why = err instanceof SecretMissing ? `no such secret: ${shown}` : `could not delete ${shown}: ${reason(err)}`
      await sayIn(chatId, topic, `🔐 ${why}.${undeleted}`)
    }
  }

  // The topic's Claude learns the path, never the value, through the same queue
  // a message takes (waking it if dormant), so nobody has to tell it. The square
  // has no Claude of its own. secret_drop=1 lets the reply guard accept silence:
  // the proxy already acked in the topic.
  function notifyTopic(chatId: string, topic: string, fromId: string, what: string): void {
    if ((SQUARE_TOPIC && topic === SQUARE_TOPIC) || harnessLocked(topic)) return
    ensureSession(topic)
    enqueue(topic, {
      content: `SYSTEM NOTICE (not a user message): ${what} No reply is required.`,
      meta: {
        chat_id: chatId,
        user: 'telegram-topics-proxy',
        user_id: fromId,
        ts: new Date().toISOString(),
        ...(topic !== 'general' ? { message_thread_id: topic } : {}),
        ...SECRET_DROP_META,
      },
    })
  }

  return { handleSecretDrop, pendingSecretFlow, handleSecretStep }
}
