// The Bot API's inbound side: every group message and inline-button answer is
// gated to the configured group, then routed to the verb, harness, square or
// Claude topic it belongs to.
import type { Api, Bot, Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { ADMIN_USER_ID, GROUP_CHAT_ID, SECRETS_USER_ID, SQUARE_TOPIC, VOICE } from '../config'
import type { TopicContext, TopicHarnessAdapter } from '../harness/topic-harness-adapter'
import type { TopicHarness } from '../harness/domain/topic-harness'
import { log } from '../log'
import type { createRouting } from '../routing/routing'
import type { createSecretDrop } from '../secrets/secret-drop'
import { SECRET_CMD_RE } from '../secrets/secret'
import type { createSquare } from '../square/square'
import type { createTopicLifecycle } from '../topics/lifecycle'
import { PERMISSION_REPLY_RE, pendingPerms, resolvePermission } from '../topics/permissions'
import { saveRegistry } from '../topics/registry'
import { topicNames, topics } from '../topics/state'
import { callbackHarness, callbackTopic, decodeCallback } from './telegram-callback'
import type { Callback } from './telegram-callback'
import type { Downloader } from './telegram-files'
import { describeMessage } from './telegram-messages'
import { transcribeVoice, VOICE_TAG } from './voice-transcription'

// "/relaunch" in a topic kills that topic's agent and respawns it with the
// same conversation, freshly loading MCP servers and settings that a running
// session cannot pick up mid-flight.
const RELAUNCH_RE = /^\/relaunch(?:@\w+)?\s*$/
const MODEL_RE = /^\/model(?:@\w+)?(?:\s+(\S+))?\s*$/
const USAGE_RE = /^\/usage(?:@\w+)?\s*$/

export type InboundPorts = {
  harnesses: readonly TopicHarnessAdapter[]
  harnessFor: (topic: string) => TopicHarnessAdapter | undefined
  topicHarnessOf: (topic: string) => TopicHarness
  sayIn: (chatId: string, topic: string, text: string) => Promise<unknown>
  downloadFile: Downloader
  lifecycle: Pick<ReturnType<typeof createTopicLifecycle>, 'enqueue' | 'ensureSession' | 'relaunch'>
  routing: Pick<
    ReturnType<typeof createRouting>,
    'handleModelCommand' | 'refreshProviderCapacity' | 'capacityText' | 'handleRouteCallback'
  >
  secrets: ReturnType<typeof createSecretDrop>
  square: Pick<ReturnType<typeof createSquare>, 'handleSquareUserMessage'>
  /** Antigravity's own model picker; true when it answered the callback. */
  harnessCallback: (ctx: Context, cb: Callback, topic: string) => Promise<boolean>
}

export function registerInbound(bot: Bot, ports: InboundPorts): void {
  const { harnesses, harnessFor, topicHarnessOf, sayIn, downloadFile, lifecycle, routing, secrets, square } = ports

  bot.catch(err => {
    process.stderr.write(`telegram-topics-proxy: handler error (polling continues): ${err.error}\n`)
  })

  bot.on('message', async ctx => {
    const msg = ctx.message
    // Access control: only the configured forum group. Everything else dropped.
    if (String(ctx.chat.id) !== String(GROUP_CHAT_ID)) return

    const topic = msg.message_thread_id != null ? String(msg.message_thread_id) : 'general'
    const chatId = String(ctx.chat.id)
    const fromId = String(ctx.from?.id ?? '')
    // One line per inbound message so a topic that never answers can be traced to arrival or to routing.
    const harness = harnessFor(topic)
    if (harness?.tracesInbound) log(`inbound topic ${topic} message ${msg.message_id ?? '(no id)'} text=${typeof msg.text === 'string'} kind=${Object.keys(msg).filter(k => ['text','photo','document','voice','sticker','location','venue','forum_topic_created','forum_topic_edited'].includes(k)).join(',') || 'other'}`)

    // Secret drop runs before every relay path, the square included, so the
    // value can reach neither a topic-Claude nor a peer. See handleSecretDrop.
    if (typeof msg.text === 'string' && SECRET_CMD_RE.test(msg.text)) {
      await secrets.handleSecretDrop(chatId, topic, msg.message_id, fromId, msg.text)
      return
    }
    const here: TopicContext = { chatId, topic, fromId }
    for (const h of harnesses) {
      const lockMatch = typeof msg.text === 'string' ? h.lockCommand.exec(msg.text) : null
      if (lockMatch) {
        await h.lock(here, lockMatch[1] ?? '')
        return
      }
    }
    if (typeof msg.text === 'string' && RELAUNCH_RE.test(msg.text)) {
      if (harness) await harness.relaunch(here)
      else await lifecycle.relaunch(chatId, topic, fromId)
      return
    }
    const modelMatch = MODEL_RE.exec(msg.text ?? '')
    if (modelMatch) {
      if (harness) {
        await harness.model(here, modelMatch[1] ?? '')
      } else {
        await routing.handleModelCommand(chatId, topic, fromId, modelMatch[1] ?? '')
      }
      return
    }
    if (USAGE_RE.test(msg.text ?? '')) {
      if (!ADMIN_USER_ID || fromId !== ADMIN_USER_ID) {
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
    if (typeof msg.text === 'string' && ctx.from) {
      const flow = secrets.pendingSecretFlow(fromId, topic)
      if (flow) {
        await secrets.handleSecretStep(chatId, topic, msg.message_id, fromId, msg.text, flow)
        return
      }
    }

    // Square-topic USER messages route by conversation membership / @tags -
    // there is no claude "for" the square, so they never hit the normal path.
    // (Service messages fall through to the name-learning handlers below.)
    if (SQUARE_TOPIC && topic === SQUARE_TOPIC && !msg.forum_topic_created && !msg.forum_topic_edited) {
      const text = msg.text ?? msg.caption ?? ''
      if (text) square.handleSquareUserMessage(msg, String(text))
      return
    }

    // Learn topic names from the creation service message; do not relay it.
    if (msg.forum_topic_created) {
      const nm = msg.forum_topic_created.name
      topicNames.set(topic, nm)
      const st = topics.get(topic)
      if (st && !st.name) st.name = nm
      harness?.rename(topic, nm)
      log(`learned topic ${topic} name "${nm}"`)
      return
    }

    // A rename (forum_topic_edited carries the new name when the title changed;
    // it is absent for an icon-only edit). Persisted, so the session takes
    // `claude-<new-slug>-<tid>` on its next respawn. Not relayed.
    if (msg.forum_topic_edited) {
      const nm = msg.forum_topic_edited.name
      if (nm) {
        topicNames.set(topic, nm)
        const st = topics.get(topic)
        if (st) {
          st.name = nm
          saveRegistry()
        }
        harness?.rename(topic, nm)
        log(`topic ${topic} renamed to "${nm}"`)
      }
      return
    }

    // A "yes <id>" / "no <id>" reply to a pending permission request in THIS
    // topic goes to the permission relay, not the agent. Any other token
    // relays as an ordinary message.
    if (typeof msg.text === 'string') {
      const pm = PERMISSION_REPLY_RE.exec(msg.text)
      if (pm) {
        const requestId = pm[2]
        const pending = pendingPerms.get(requestId)
        if (pending && pending.topic === topic) {
          const behavior = pm[1].toLowerCase().startsWith('y') ? 'allow' : 'deny'
          resolvePermission(requestId, behavior)
          if (msg.message_id != null) {
            const emoji = behavior === 'allow' ? '✅' : '❌'
            void bot.api
              .setMessageReaction(chatId, msg.message_id, [
                { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
              ])
              .catch(() => {})
          }
          return
        }
      }
    }

    const desc = describeMessage(msg)
    if (!desc) return // service message with nothing to relay

    const takesFiles = harness?.attachments !== 'none'
    let imagePath: string | undefined
    if (takesFiles && desc.photo) {
      imagePath = (await downloadFile(desc.photo.file_id, desc.photo.file_unique_id)) ?? undefined
    }

    // A Claude topic fetches other attachments itself through download_attachment;
    // a harness that does not load that plugin gets each one downloaded up front.
    let attachmentPath: string | undefined
    if (harness?.attachments === 'eager' && desc.attachment && !imagePath) {
      attachmentPath = (await downloadFile(desc.attachment.file_id, desc.attachment.name)) ?? undefined
    }

    let voiceTranscribed = false
    if (takesFiles && desc.attachment?.kind === 'voice') {
      const text = await transcribeVoice(VOICE, downloadFile, desc.attachment.file_id, log)
      if (text) {
        desc.content = (msg.caption ? `${msg.caption}\n\n` : '') + `${VOICE_TAG}\n${text}`
        voiceTranscribed = true
      }
    }

    const from = ctx.from!
    const meta: Record<string, string> = {
      chat_id: chatId,
      ...(msg.message_id != null ? { message_id: String(msg.message_id) } : {}),
      user: from.username ?? String(from.id),
      user_id: String(from.id),
      ts: new Date((msg.date ?? 0) * 1000).toISOString(),
      ...(msg.message_thread_id != null ? { message_thread_id: String(msg.message_thread_id) } : {}),
      ...(imagePath ? { image_path: imagePath } : {}),
      ...(attachmentPath ? { attachment_path: attachmentPath } : {}),
      ...(voiceTranscribed ? { voice_transcribed: '1' } : {}),
      ...(desc.attachment
        ? {
            attachment_kind: desc.attachment.kind,
            attachment_file_id: desc.attachment.file_id,
            ...(desc.attachment.size != null ? { attachment_size: String(desc.attachment.size) } : {}),
            ...(desc.attachment.mime ? { attachment_mime: desc.attachment.mime } : {}),
            ...(desc.attachment.name ? { attachment_name: desc.attachment.name } : {}),
          }
        : {}),
    }

    if (harness) {
      await harness.receive(here, {
        ...(msg.message_id != null ? { messageId: msg.message_id } : {}),
        ...(typeof msg.text === 'string' ? { text: msg.text } : {}),
        content: desc.content,
        meta,
      })
      return
    }

    // Spawn the topic's Claude if none is live, then enqueue. The message waits
    // in the queue until the new MCP's first /poll drains it.
    lifecycle.ensureSession(topic)
    lifecycle.enqueue(topic, { content: desc.content, meta })
  })

  // Inline-button answers. Route pickers are operator-only and bound to the topic
  // and harness that emitted them. A permission answer's access control is the
  // group gate: only members of the configured forum group can tap a button that
  // lives in that group's thread. Answers and edits here are not logged when they
  // fail: Telegram refuses a late answer or an edit that changes nothing routinely.
  bot.on('callback_query:data', async ctx => {
    const cb = decodeCallback(ctx.callbackQuery.data ?? '')
    if (!cb) {
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    if (cb.kind !== 'permission') {
      const cbChatId = ctx.callbackQuery.message?.chat.id
      const fromId = String(ctx.callbackQuery.from.id)
      if (String(cbChatId) !== String(GROUP_CHAT_ID) || !ADMIN_USER_ID || fromId !== ADMIN_USER_ID) {
        await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
        return
      }

      const currentTopic = (ctx.callbackQuery.message as any)?.message_thread_id != null
        ? String((ctx.callbackQuery.message as any).message_thread_id)
        : 'general'
      const currentHarness = topicHarnessOf(currentTopic)
      const namedTopic = callbackTopic(cb)
      if (namedTopic && namedTopic !== currentTopic) {
        await ctx.answerCallbackQuery({
          text: 'This control belongs to a different Telegram topic.',
          show_alert: true,
        }).catch(() => {})
        return
      }
      const emitter = callbackHarness(cb)
      if (emitter && emitter !== currentHarness) {
        await ctx.answerCallbackQuery({
          text: currentHarness === 'antigravity'
            ? 'This topic is locked to Google / Antigravity. External provider routes are disabled.'
            : currentHarness === 'opencode'
              ? 'This topic is locked to OpenCode / local Qwen. Model and provider pickers are disabled.'
              : currentHarness === 'localgen'
                ? 'This topic is locked to localgen. Model and provider pickers are disabled.'
                : 'This picker belongs to an Antigravity-locked topic.',
          show_alert: true,
        }).catch(() => {})
        return
      }

      if (await ports.harnessCallback(ctx, cb, currentTopic)) return

      if (await routing.handleRouteCallback(ctx, cb)) return

      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    const cbChatId = ctx.callbackQuery.message?.chat.id
    if (String(cbChatId) !== String(GROUP_CHAT_ID)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const { behavior, requestId } = cb
    const delivered = resolvePermission(requestId, behavior)
    if (!delivered) {
      await ctx.answerCallbackQuery({ text: 'No longer pending.' }).catch(() => {})
      return
    }
    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    await ctx.answerCallbackQuery({ text: label }).catch(() => {})
    // Replace the buttons with the outcome so the same request cannot be answered
    // twice and the chat history shows what was chosen.
    const msg = ctx.callbackQuery.message
    if (msg && 'text' in msg && msg.text) {
      await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
    }
  })
}

// The "/" menu: discoverable, autocompleted, and free of the "--" a phone
// keyboard mangles. Scoped to the group so no other chat learns the verbs.
// Idempotent, and a failure only costs the menu, never the commands.
export async function registerCommands(api: Api): Promise<void> {
  const commands = [
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
    await api.setMyCommands(commands, { scope: { type: 'chat', chat_id: Number(GROUP_CHAT_ID) } })
    log(`registered ${commands.map(c => '/' + c.command).join(', ')} in the group command menu`)
  } catch (err) {
    log(`could not register the group commands: ${err}`)
  }
}
