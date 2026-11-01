// Whether this process belongs to a background Claude session (an Agent-tool or
// `claude daemon` job) rather than a topic's foreground Claude. A background
// session inherits the topic's environment, TELEGRAM_TOPIC_ID included, but has
// no channel: a turn it polls off the topic's queue is consumed and never shown.
// Claude Code does not hand every marker to MCP servers, so any one counts:
// CLAUDE_JOB_DIR is the background job's own directory.
export function isBackgroundSession(env: NodeJS.ProcessEnv): boolean {
  return env.CLAUDE_CODE_SESSION_KIND === 'bg' || !!env.CLAUDE_BG_BACKEND || !!env.CLAUDE_JOB_DIR
}
