// The square: one forum topic hosting every agent-to-agent conversation. It
// delivers to participants or tagged topics only, never broadcast.
import type { ChatPort } from '../chat/domain/chat-port'
import { SQUARE_TOPIC } from '../config'
import type { InboundMessage } from '../shared/domain/inbound-delivery'
import { topicSlug } from '../shared/domain/topic-slug'
import { SQUARE_META } from '../shared/domain/turn-meta'
import { parseSquareReply, parseSquareTag } from '../http/requests'
import { json } from '../http/response'
import { log } from '../log'
import { mux } from '../topics/mux'
import { topicNames, topics } from '../topics/state'
import { convs, saveConvs } from './conversations'

/** What the square needs from the rest of the proxy. */
export type SquarePorts = {
  chat: Pick<ChatPort, 'send' | 'link' | 'messageId'>
  /** True for a topic another harness owns, which takes no square deliveries. */
  harnessLocked: (topic: string) => boolean
  /** Wakes a dormant topic's agent; a tag counts as a first message. */
  ensureSession: (topic: string) => void
  enqueue: (topic: string, message: InboundMessage) => void
}

export function createSquare({ chat, harnessLocked, ensureSession, enqueue }: SquarePorts) {
  // Topic directory: every known topic (live or dormant) addressable by slug.
  // The square itself and never-spawned unnamed topics are excluded.
  function topicDirectory(): Array<{ slug: string; name: string; topic: string; live: boolean }> {
    const live = mux.liveSessions()
    const out: Array<{ slug: string; name: string; topic: string; live: boolean }> = []
    for (const [topic, st] of topics) {
      if (topic === SQUARE_TOPIC || harnessLocked(topic)) continue
      const name = st.name || topicNames.get(topic) || ''
      const slug = topic === 'general' ? 'general' : topicSlug(name) !== 'topic' ? topicSlug(name) : topic
      out.push({ slug, name: name || topic, topic, live: st.agent.state === 'running' && live.has(st.agent.session) })
    }
    return out
  }

  function resolvePeer(peer: string): string | null {
    const p = peer.trim().toLowerCase().replace(/^@/, '')
    for (const e of topicDirectory()) {
      if (e.slug === p || e.topic === p) return e.topic
    }
    return null
  }

  function slugForTopic(topic: string): string {
    for (const e of topicDirectory()) if (e.topic === topic) return e.slug
    return topic
  }


  // The standing per-delivery norm (the "pre-message hook"): conversation
  // discipline is behavioral, not enforced - see the design doc. Appended to
  // every square delivery's content.
  function squareNorm(conv: string, replyToken: number): string {
    return (
      `[square message - NOT from your topic's user. To respond, use the square_reply tool with ` +
      `conv="${conv}" and reply_token="${replyToken}" - do NOT use the reply tool (it posts to your ` +
      `own topic, the wrong room; this message did not come from there). Reply ONLY if it moves the ` +
      `work forward; a closing courtesy is fine, courtesy-for-courtesy is not; if no reply is ` +
      `warranted, do nothing - silence politely ends a conversation here and no reply-guard will nag you.]`
    )
  }

  // Deliver a square message to a set of topics (recipient set = participants
  // or tagged claudes, NEVER broadcast). Wakes dormant claudes (a tag counts as
  // a first message).
  function deliverSquare(
    recipients: string[],
    text: string,
    meta: { conv: string; reply_token: number; from: string; origin_topic: string; depth: number },
  ): void {
    for (const topic of recipients) {
      if (topic === SQUARE_TOPIC) continue
      if (harnessLocked(topic)) {
        log(`dropping square delivery (conv ${meta.conv}) to harness-locked topic ${topic}`)
        continue
      }
      ensureSession(topic)
      // NB deliberately NO chat_id / message_id keys in this meta: the channel
      // instructions train "reply via the reply tool with chat_id from the
      // inbound block", and a resumed long-lived session follows that habit
      // straight into posting square answers in its OWN topic (observed live,
      // 2026-07-17). Omitting those keys removes the affordance - the only
      // executable recipe in the meta is square_reply's (conv + reply_token),
      // and the norm line says so explicitly.
      enqueue(topic, {
        content: `${text}\n\n${squareNorm(meta.conv, meta.reply_token)}`,
        meta: {
          ...SQUARE_META,
          conv: meta.conv,
          reply_token: String(meta.reply_token),
          from: meta.from,
          origin_topic: meta.origin_topic,
          depth: String(meta.depth),
          ts: new Date().toISOString(),
        },
      })
    }
  }

  // POST /square/tag {topic, peer, text} - open a conversation. Posts the root
  // message in the square, registers the conv, breadcrumbs the caller's topic,
  // delivers to (and wakes) the peer.
  async function handleSquareTag(req: Request): Promise<Response> {
    if (!SQUARE_TOPIC) return new Response('square not configured', { status: 404 })
    const b = parseSquareTag(await req.json())
    const caller = b.caller
    const peer = resolvePeer(b.peer)
    const text = b.text
    if (!peer) {
      const dir = topicDirectory().map(e => e.slug).join(', ')
      return new Response(`unknown peer; known topics: ${dir}`, { status: 400 })
    }
    if (peer === caller) return new Response('cannot tag yourself', { status: 400 })
    if (!text) return new Response('text required', { status: 400 })

    // VIRTUAL CALLERS: any caller that is not a real topic ("operator", "ci",
    // future automations) renders in the header but must never become a
    // conversation participant - a participant gets deliveries, and delivery
    // calls ensureSession, which would SPAWN a claude for a topic that does
    // not exist. Real topics keep the full breadcrumb + participant behavior.
    const realTopics = new Set(topicDirectory().map(e => e.topic))
    const callerIsReal = realTopics.has(caller)
    const callerSlug = callerIsReal ? slugForTopic(caller) : caller.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'operator' 
    const peerSlug = slugForTopic(peer)
    const header = `🤖 ${callerSlug} → @${peerSlug}`
    const [root] = await chat.send(SQUARE_TOPIC, { text: `${header}\n${text}` })
    const conv = String(root)
    convs.set(conv, {
      participants: callerIsReal ? [...new Set([caller, peer])] : [peer],
      last_msg_id: root,
      origin_topic: caller,
      depth: 1,
      updated_at: Date.now(),
    })
    saveConvs()

    // Breadcrumb in the caller's own room (real claude callers only), with a deep link.
    if (callerIsReal) {
      chat
        .send(caller, { text: `↪️ asked @${peerSlug} in #square: ${chat.link(SQUARE_TOPIC, root) ?? 'the square'}` })
        .catch(e => log(`breadcrumb failed for ${caller}: ${e}`))
    }

    deliverSquare([peer], `(square conversation #${conv}, opened by ${callerSlug}) ${text}`, {
      conv,
      reply_token: root,
      from: callerSlug,
      origin_topic: caller,
      depth: 1,
    })
    log(`square: ${callerSlug} tagged ${peerSlug} -> conv ${conv}`)
    return json({ conv, message_id: root })
  }

  // POST /square/reply {topic, conv, reply_token?, text} - continue a
  // conversation this claude participates in. Threads under the message being
  // answered (reply_token from the notification meta) or the conv root as the
  // safe fallback - a stray unthreaded message is not expressible.
  async function handleSquareReply(req: Request): Promise<Response> {
    if (!SQUARE_TOPIC) return new Response('square not configured', { status: 404 })
    const b = parseSquareReply(await req.json())
    const { caller, conv, text } = b
    const c = convs.get(conv)
    if (!c) {
      return new Response('conversation not found (expired or never existed); use square_tag to start a new one', {
        status: 404,
      })
    }
    if (caller !== 'operator' && !c.participants.includes(caller)) {
      return new Response('not a participant of this conversation; use square_tag to start your own', { status: 403 })
    }
    if (!text) return new Response('text required', { status: 400 })

    const replyTo = chat.messageId(b.replyToken ?? conv)
    const callerSlug = caller === 'operator' ? 'operator' : slugForTopic(caller)
    const [posted] = await chat.send(SQUARE_TOPIC, { text: `🤖 ${callerSlug} · #${conv}\n${text}`, ...(replyTo ? { replyTo } : {}) })
    c.last_msg_id = posted
    c.depth += 1
    c.updated_at = Date.now()
    saveConvs()

    const recipients = c.participants.filter(t => t !== caller)
    deliverSquare(recipients, text, {
      conv,
      reply_token: posted,
      from: callerSlug,
      origin_topic: c.origin_topic,
      depth: c.depth,
    })
    log(`square: ${callerSlug} replied in conv ${conv} (depth ${c.depth})`)
    return json({ message_id: posted })
  }

  // Inbound handling for USER messages posted in the square topic. Reply-chain
  // membership or an explicit @tag addresses claudes; an untagged non-reply is
  // visible text delivered to no one. A human message in a conv RESETS its
  // depth (human presence re-authorizes budget) and re-registers a conv lazily
  // if conversations.json was lost (the self-describing "#<conv>" header in the
  // replied-to message).
  function handleSquareUserMessage(msg: any, text: string): void {
    const uname = msg.from?.username ?? String(msg.from?.id ?? 'operator')
    // 1. Reply within a chain?
    const parent = msg.reply_to_message
    if (parent) {
      const parentText = String(parent.text ?? '')
      let conv = convs.has(String(parent.message_id)) ? String(parent.message_id) : ''
      if (!conv) {
        const m = parentText.match(/#(\d+)/)
        if (m && convs.has(m[1])) conv = m[1]
        else if (m) {
          // Lazy rederivation: rebuild a minimal conv entry from the footer.
          conv = m[1]
          convs.set(conv, {
            participants: [],
            last_msg_id: parent.message_id,
            origin_topic: 'unknown',
            depth: 0,
            updated_at: Date.now(),
          })
          log(`square: rederived conv ${conv} from message footer`)
        }
      }
      if (conv) {
        const c = convs.get(conv)!
        // Participants may also be rederivable from the parent header (slugs).
        if (c.participants.length === 0) {
          const slugs = parentText.match(/🤖 ([a-z0-9-]+)(?: → @([a-z0-9-]+))?/)
          for (const s of [slugs?.[1], slugs?.[2]]) {
            const t = s ? resolvePeer(s) : null
            if (t) c.participants.push(t)
          }
        }
        c.depth = 0 // human message resets the budget clock
        c.last_msg_id = msg.message_id
        c.updated_at = Date.now()
        saveConvs()
        deliverSquare(c.participants, text, {
          conv,
          reply_token: msg.message_id,
          from: `operator (${uname})`,
          origin_topic: 'square',
          depth: 0,
        })
        log(`square: operator replied in conv ${conv}`)
        return
      }
    }
    // 2. Fresh @tags open new conversation(s).
    const tags = [...text.matchAll(/@([a-z0-9-]+)/gi)].map(m => m[1])
    const peers = [...new Set(tags.map(t => resolvePeer(t)).filter((t): t is string => !!t))]
    if (peers.length > 0) {
      const conv = String(msg.message_id)
      convs.set(conv, {
        participants: peers,
        last_msg_id: msg.message_id,
        origin_topic: 'square',
        depth: 0,
        updated_at: Date.now(),
      })
      saveConvs()
      deliverSquare(peers, text, {
        conv,
        reply_token: msg.message_id,
        from: `operator (${uname})`,
        origin_topic: 'square',
        depth: 0,
      })
      log(`square: operator opened conv ${conv} with ${peers.join(',')}`)
    }
    // 3. Untagged non-reply: visible text, delivered to no one.
  }

  return { topicDirectory, slugForTopic, handleSquareTag, handleSquareReply, handleSquareUserMessage }
}
