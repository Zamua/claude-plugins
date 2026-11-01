// Every chat event, routed to what it belongs to: a verb, the secret drop, a
// harness, the square, a permission answer, a picker, or a Claude topic's queue.
// The transport has already gated the chat and verified the sender.
import { ADMIN_USER_ID, SECRETS_USER_ID, SQUARE_TOPIC, VOICE } from '../config'
import type { TopicContext, TopicHarnessAdapter } from '../harness/topic-harness-adapter'
import type { TopicHarness } from '../harness/domain/topic-harness'
import { log } from '../log'
import type { createRouting } from '../routing/routing'
import type { createSecretDrop } from '../secrets/secret-drop'
import { SECRET_CMD_RE } from '../secrets/secret'
import type { createSquare } from '../square/square'
import { transcribeVoice, VOICE_TAG } from '../telegram/voice-transcription'
import type { createTopicLifecycle } from '../topics/lifecycle'
import { PERMISSION_REPLY_RE, pendingPerms, resolvePermission } from '../topics/permissions'
import { learnTopicName, saveRegistry } from '../topics/registry'
import { spawnedNode } from '../topics/domain/session-tree'
import { topicNames, topics } from '../topics/state'
import { intentHarness, intentTopic } from './domain/actions'
import type { ActionPress } from './domain/actions'
import type { ChatCommand, ChatPort } from './domain/chat-port'
import type { ChatEvent, ChatMessage } from './domain/inbound'

// "/relaunch" in a topic kills that topic's agent and respawns it with the
// same conversation, freshly loading MCP servers and settings that a running
// session cannot pick up mid-flight.
const RELAUNCH_RE = /^\/relaunch(?:@\w+)?\s*$/
const MODEL_RE = /^\/model(?:@\w+)?(?:\s+(\S+))?\s*$/
const USAGE_RE = /^\/usage(?:@\w+)?\s*$/

export type InboundPorts = {
  chat: Pick<ChatPort, 'download' | 'react'>
  harnesses: readonly TopicHarnessAdapter[]
  harnessFor: (topic: string) => TopicHarnessAdapter | undefined
  topicHarnessOf: (topic: string) => TopicHarness
  sayIn: (chatId: string, topic: string, text: string) => Promise<unknown>
  lifecycle: Pick<ReturnType<typeof createTopicLifecycle>, 'enqueue' | 'ensureSession' | 'relaunch'>
  routing: Pick<
    ReturnType<typeof createRouting>,
    'handleModelCommand' | 'refreshProviderCapacity' | 'capacityText' | 'handleRouteAction'
  >
  secrets: ReturnType<typeof createSecretDrop>
  square: Pick<ReturnType<typeof createSquare>, 'handleSquareUserMessage'>
  /** Antigravity's own model picker; true when it answered the press. */
  harnessAction: (press: ActionPress) => Promise<boolean>
}

export function createInboundRouter(ports: InboundPorts): (event: ChatEvent) => Promise<void> {
  const { chat, harnesses, harnessFor, topicHarnessOf, sayIn, lifecycle, routing, secrets, square } = ports
  const download = (ref: string, hint?: string) => chat.download(ref, hint)

  async function onMessage(message: ChatMessage): Promise<void> {
    const { topic, chatId } = message
    const fromId = message.sender.id
    const text = message.text
    // One line per inbound message so a topic that never answers can be traced to arrival or to routing.
    const harness = harnessFor(topic)
    if (harness?.tracesInbound) log(`inbound topic ${topic} message ${message.id} text=${text !== undefined} kind=${message.shape}`)

    // Secret drop runs before every relay path, the square included, so the
    // value can reach neither a topic-Claude nor a peer. See handleSecretDrop.
    if (text !== undefined && SECRET_CMD_RE.test(text)) {
      await secrets.handleSecretDrop(chatId, topic, message.id, fromId, text)
      return
    }
    const here: TopicContext = { chatId, topic, fromId }
    for (const h of harnesses) {
      const lockMatch = text !== undefined ? h.lockCommand.exec(text) : null
      if (lockMatch) {
        await h.lock(here, lockMatch[1] ?? '')
        return
      }
    }
    if (text !== undefined && RELAUNCH_RE.test(text)) {
      if (harness) await harness.relaunch(here)
      else await lifecycle.relaunch(chatId, topic, fromId)
      return
    }
    const modelMatch = MODEL_RE.exec(text ?? '')
    if (modelMatch) {
      if (harness) {
        await harness.model(here, modelMatch[1] ?? '')
      } else {
        await routing.handleModelCommand(chatId, topic, fromId, modelMatch[1] ?? '')
      }
      return
    }
    if (USAGE_RE.test(text ?? '')) {
      if (message.sender.role !== 'operator') {
        await sayIn(chatId, topic, 'Only the operator can inspect provider usage.')
      } else if (harness) {
        await harness.usage(here)
      } else {
        await routing.refreshProviderCapacity()
        await sayIn(chatId, topic, routing.capacityText())
      }
      return
    }
    // A reply to a guided-flow prompt (name or value) belongs to the flow and is
    // never relayed. Checked after the verbs so a fresh /secret restarts cleanly.
    if (text !== undefined) {
      const flow = secrets.pendingSecretFlow(fromId, topic)
      if (flow) {
        await secrets.handleSecretStep(chatId, topic, message.id, fromId, text, flow)
        return
      }
    }

    // Square-topic USER messages route by conversation membership / @tags -
    // there is no claude "for" the square, so they never hit the normal path.
    // (Service messages fall through to the name-learning handlers below.)
    if (SQUARE_TOPIC && topic === SQUARE_TOPIC && !message.service) {
      const said = text ?? message.caption ?? ''
      if (said) square.handleSquareUserMessage(message, said)
      return
    }

    // Learn topic names from the creation service message; do not relay it.
    if (message.service?.kind === 'created') {
      const nm = message.service.name ?? ''
      topicNames.set(topic, nm)
      const st = topics.get(topic)
      if (st && !st.name) st.name = nm
      if (st && !st.session) {
        st.session = spawnedNode(topic, message.sender.role === 'operator' ? 'operator' : String(message.sender.id), id => topics.has(id), new Date(message.at).toISOString())
        saveRegistry()
      }
      harness?.rename(topic, nm)
      log(`learned topic ${topic} name "${nm}"`)
      return
    }

    // A rename carries the new name when the title changed; it is absent for an
    // icon-only edit. Persisted, so the session takes `claude-<new-slug>-<tid>` on
    // its next respawn. Not relayed.
    if (message.service?.kind === 'renamed') {
      const nm = message.service.name
      if (nm) {
        learnTopicName(topic, nm)
        harness?.rename(topic, nm)
        log(`topic ${topic} renamed to "${nm}"`)
      }
      return
    }

    // A "yes <id>" / "no <id>" reply to a pending permission request in THIS
    // topic goes to the permission relay, not the agent. Any other token
    // relays as an ordinary message.
    if (text !== undefined) {
      const pm = PERMISSION_REPLY_RE.exec(text)
      if (pm) {
        const requestId = pm[2]
        const pending = pendingPerms.get(requestId)
        if (pending && pending.topic === topic) {
          const behavior = pm[1].toLowerCase().startsWith('y') ? 'allow' : 'deny'
          resolvePermission(requestId, behavior)
          void chat.react(message.id, behavior === 'allow' ? '✅' : '❌').catch(() => {})
          return
        }
      }
    }

    if (message.content === undefined) return // a service message with nothing to relay
    let content = message.content

    const takesFiles = harness?.attachments !== 'none'
    let imagePath: string | undefined
    if (takesFiles && message.photo) {
      imagePath = (await download(message.photo.ref, message.photo.uniqueRef)) ?? undefined
    }

    // A Claude topic fetches other attachments itself through download_attachment;
    // a harness that does not load that plugin gets each one downloaded up front.
    const attachment = message.attachment
    let attachmentPath: string | undefined
    if (harness?.attachments === 'eager' && attachment && !imagePath) {
      attachmentPath = (await download(attachment.ref, attachment.name)) ?? undefined
    }

    let voiceTranscribed = false
    if (takesFiles && attachment?.kind === 'voice') {
      const transcript = await transcribeVoice(VOICE, download, attachment.ref, log)
      if (transcript) {
        content = (message.caption ? `${message.caption}\n\n` : '') + `${VOICE_TAG}\n${transcript}`
        voiceTranscribed = true
      }
    }

    const meta: Record<string, string> = {
      chat_id: chatId,
      message_id: String(message.id),
      user: message.sender.name,
      user_id: message.sender.id,
      ts: new Date(message.at).toISOString(),
      ...(topic !== 'general' ? { message_thread_id: topic } : {}),
      ...(imagePath ? { image_path: imagePath } : {}),
      ...(attachmentPath ? { attachment_path: attachmentPath } : {}),
      ...(voiceTranscribed ? { voice_transcribed: '1' } : {}),
      ...(attachment
        ? {
            attachment_kind: attachment.kind,
            attachment_file_id: attachment.ref,
            ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
            ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
            ...(attachment.name ? { attachment_name: attachment.name } : {}),
          }
        : {}),
    }

    if (harness) {
      await harness.receive(here, {
        messageId: message.id,
        ...(text !== undefined ? { text } : {}),
        content,
        meta,
      })
      return
    }

    // Spawn the topic's Claude if none is live, then enqueue. The message waits
    // in the queue until the new MCP's first /poll drains it.
    lifecycle.ensureSession(topic)
    lifecycle.enqueue(topic, { content, meta })
  }

  // Route pickers are operator-only and bound to the topic and harness that made
  // them. A permission answer's access control is the chat gate: only members of
  // the group can press a button in it. Answers and edits here are not logged
  // when they fail: a transport may refuse a late answer or an edit that changes nothing.
  async function onAction(press: ActionPress): Promise<void> {
    const cb = press.intent
    if (cb.kind !== 'permission') {
      if (press.sender.role !== 'operator') {
        await press.answer({ text: 'Not authorized.' }).catch(() => {})
        return
      }
      const currentHarness = topicHarnessOf(press.topic)
      const namedTopic = intentTopic(cb)
      if (namedTopic && namedTopic !== press.topic) {
        await press.answer({ text: 'This control belongs to a different Telegram topic.', alert: true }).catch(() => {})
        return
      }
      const emitter = intentHarness(cb)
      if (emitter && emitter !== currentHarness) {
        await press.answer({
          text: currentHarness === 'antigravity'
            ? 'This topic is locked to Google / Antigravity. External provider routes are disabled.'
            : currentHarness === 'opencode'
              ? 'This topic is locked to OpenCode / local Qwen. Model and provider pickers are disabled.'
              : currentHarness === 'localgen'
                ? 'This topic is locked to localgen. Model and provider pickers are disabled.'
                : 'This picker belongs to an Antigravity-locked topic.',
          alert: true,
        }).catch(() => {})
        return
      }

      if (await ports.harnessAction(press)) return

      if (await routing.handleRouteAction(press)) return

      await press.answer().catch(() => {})
      return
    }
    const { behavior, requestId } = cb
    const delivered = resolvePermission(requestId, behavior)
    if (!delivered) {
      await press.answer({ text: 'No longer pending.' }).catch(() => {})
      return
    }
    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    await press.answer({ text: label }).catch(() => {})
    // Replace the buttons with the outcome so the same request cannot be answered
    // twice and the chat history shows what was chosen.
    if (press.text) await press.update(`${press.text}\n\n${label}`).catch(() => {})
  }

  return async event => {
    if (event.type === 'message') await onMessage(event.message)
    else if (event.type === 'action') await onAction(event.press)
  }
}

// The "/" menu: discoverable, autocompleted, and free of the "--" a phone
// keyboard mangles. Scoped to the group so no other chat learns the verbs.
// Idempotent, and a failure only costs the menu, never the commands.
export async function registerCommands(chat: Pick<ChatPort, 'setCommands'>): Promise<void> {
  const commands: ChatCommand[] = [
    { command: 'relaunch', description: "restart this topic's agent (same conversation, reloads MCP config)" },
    ...(ADMIN_USER_ID
      ? [
          { command: 'antigravity', description: 'lock a fresh topic to the Antigravity harness' },
          { command: 'localcode', description: 'lock a fresh topic to the local OpenCode/Qwen harness' },
          { command: 'localgen', description: 'lock a fresh topic to the local image generator (prompts in, PNGs out)' },
          { command: 'model', description: 'choose this topic\'s provider and model' },
          { command: 'usage', description: 'show usage and reset times for every provider' },
        ]
      : []),
    ...(SECRETS_USER_ID
      ? [
          { command: 'secret', description: 'store a credential: /secret <name>, value on the next line' },
          { command: 'secrets', description: 'list stored credentials (names and sizes only)' },
          { command: 'unsecret', description: 'delete a stored credential: /unsecret <name>' },
        ]
      : []),
  ]
  try {
    await chat.setCommands(commands)
    log(`registered ${commands.map(c => '/' + c.command).join(', ')} in the group command menu`)
  } catch (err) {
    log(`could not register the group commands: ${err}`)
  }
}
