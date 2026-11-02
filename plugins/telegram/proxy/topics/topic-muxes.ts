// The multiplexers hosting Claude topics: the boot default for every topic, and
// herdr-core for the topics configured onto it, so topics move one at a time.
import type { TopicSelection } from './domain/topic-selection'
import type { MultiplexerPort } from './multiplexer'

export type TopicMuxes = {
  forTopic(topic: string): MultiplexerPort
  /** Every backend's live sessions. */
  liveSessions(): Set<string>
  /** The other backends where `session` still runs: a topic moved since it started. */
  elsewhere(topic: string, session: string): MultiplexerPort[]
  /** Stops `session` on every backend where it runs, so a topic moved since it started never keeps a copy behind. */
  kill(session: string): boolean
}

export function topicMuxes(
  fallback: MultiplexerPort,
  hc: MultiplexerPort | undefined,
  hcTopics: Pick<TopicSelection, 'has'>,
  /** Backends topics ran on before: searched and stopped, never started on. */
  previous: readonly MultiplexerPort[] = [],
): TopicMuxes {
  const all = [fallback, ...(hc ? [hc] : []), ...previous]
  const forTopic = (topic: string) => (hc && hcTopics.has(topic) ? hc : fallback)
  return {
    forTopic,
    liveSessions: () => new Set(all.flatMap(m => [...m.liveSessions()])),
    elsewhere: (topic, session) => all.filter(m => m !== forTopic(topic) && m.liveSessions().has(session)),
    kill: session => all.filter(m => m.liveSessions().has(session)).map(m => m.kill(session)).some(Boolean),
  }
}
