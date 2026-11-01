// Telegram never echoes a bot's own actions via getUpdates, so a topic the bot
// creates is invisible until a human messages it. Created here, the response
// carries its thread id and it is registered at once. Needs the bot to be a
// group admin with can_manage_topics.
import type { ChatPort } from '../chat/domain/chat-port'
import type { LockedHarness, TopicHarness } from '../harness/domain/topic-harness'
import type { TopicHarnessAdapter } from '../harness/topic-harness-adapter'
import { log } from '../log'
import { saveRegistry } from './registry'
import { getTopic, topicNames } from './state'

export type TopicCreationPorts = {
  chat: Pick<ChatPort, 'createTopic'>
  harnessOfKind: (kind: LockedHarness) => TopicHarnessAdapter
}

export function createTopicCreation({ chat, harnessOfKind }: TopicCreationPorts) {
  /** Creates and registers a forum topic, locked to `harness` unless that is Claude, and gives its id. */
  return async function createTopic(name: string, harness: TopicHarness): Promise<string> {
    const lockNewTopic = harness === 'claude' ? undefined : await harnessOfKind(harness).prepareTopic(name)
    const topic = await chat.createTopic(name)
    const st = getTopic(topic)
    st.name = name
    topicNames.set(topic, name)
    saveRegistry()
    if (lockNewTopic) await lockNewTopic(topic)
    log(`created + registered topic ${topic} "${name}"`)
    return topic
  }
}
