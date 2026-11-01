// Which Claude conversation a topic's agent runs. A topic stays bound to one
// conversation; /relaunch is the only path that replaces a bound conversation,
// and only when its transcript is gone.

// A spawn resumes the bound conversation, or mints and starts a new one.
export function spawnConversation(
  bound: string | undefined,
  mint: () => string,
): { claudeSessionId: string; resume: boolean } {
  return bound ? { claudeSessionId: bound, resume: true } : { claudeSessionId: mint(), resume: false }
}

export function missingConversationNotice(sessionId: string): string {
  return (
    `This topic's Claude conversation (${sessionId}) no longer exists on disk, so it cannot be resumed. ` +
    `Nothing was started and your message was not delivered. ` +
    `Send /relaunch to start a fresh conversation in this topic.`
  )
}

// Posted in the topic when its agent could not be started. The inbound message
// stays queued, so the next message or /relaunch retries the start.
export function spawnFailureNotice(detail: string): string {
  const cause = detail.length > 300 ? `${detail.slice(0, 300)}…` : detail
  return (
    `Could not start this topic's agent: ${cause}\n` +
    'Your message is queued and is delivered once the agent starts. Send another message or /relaunch to retry.'
  )
}

export type RelaunchPlan = {
  // The topic's binding after the relaunch; undefined makes the next spawn start a new conversation.
  claudeSessionId?: string
  // The bound conversation being replaced because its transcript is gone.
  missingSessionId?: string
  // Posted in the topic by the proxy.
  ack: string
  // Queued for the respawned agent.
  notice: string
}

export function planRelaunch(
  bound: string | undefined,
  onDisk: (sessionId: string) => boolean,
  wasLive: boolean,
): RelaunchPlan {
  if (bound && !onDisk(bound)) {
    return {
      missingSessionId: bound,
      ack:
        `♻️ this topic's conversation (${bound}) was missing on disk, so a new conversation was started ` +
        'with freshly loaded MCP servers and settings.',
      notice:
        'SYSTEM NOTICE (not a user message): the operator relaunched this session. Its previous conversation ' +
        `(${bound}) was missing on disk, so this is a NEW conversation with no earlier history, running with ` +
        'freshly loaded MCP servers and settings. Reply with ONE short line confirming you are up and naming ' +
        'the MCP servers you now see.',
    }
  }
  return {
    claudeSessionId: bound,
    ack:
      `♻️ relaunching this topic's agent${wasLive ? '' : ' (it was not running)'}: same conversation, ` +
      'freshly loaded MCP servers and settings.',
    notice:
      'SYSTEM NOTICE (not a user message): the operator relaunched this session, so it has just restarted ' +
      'with your full conversation intact and freshly loaded MCP servers and settings. Reply with ONE short ' +
      'line confirming you are back and naming the MCP servers you now see, then continue any pending work.',
  }
}
