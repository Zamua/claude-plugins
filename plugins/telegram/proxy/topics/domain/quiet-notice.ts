// Turns the operator did not send. The operator talks to general and general to
// the sessions, so a session answers these to general, never in its own topic.

export const REPORT_TO_GENERAL = 'This turn did not come from the operator: do not post in this topic. Report to the general session with SendMessage.'

/** A turn general (or a quiet reminder) starts in a topic, with what it asks for. */
export function quietNotice(origin: string, instructions?: string): string {
  return `SYSTEM NOTICE (not a user message): ${origin}. ${instructions ? `Instructions: ${instructions} ` : ''}${REPORT_TO_GENERAL}`
}
