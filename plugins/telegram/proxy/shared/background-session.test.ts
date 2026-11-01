import { expect, test } from 'bun:test'
import { isBackgroundSession } from './background-session'

// The environment a topic's foreground Claude hands its telegram MCP server.
const foreground = {
  TELEGRAM_TOPIC_ID: 'general',
  TELEGRAM_PROXY_URL: 'http://localhost:8790',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_PROJECT_DIR: '/work',
  CLAUDE_PLUGIN_ROOT: '/plugin',
}

test('a foreground topic session polls its queue', () => {
  expect(isBackgroundSession(foreground)).toBeFalse()
})

test('a background job is recognised by its job directory alone, the marker its MCP servers get', () => {
  expect(isBackgroundSession({ ...foreground, CLAUDE_JOB_DIR: '/home/.claude/jobs/60cbe135' })).toBeTrue()
})

test('the session kind or the background backend also marks one', () => {
  expect(isBackgroundSession({ ...foreground, CLAUDE_CODE_SESSION_KIND: 'bg' })).toBeTrue()
  expect(isBackgroundSession({ ...foreground, CLAUDE_BG_BACKEND: 'daemon' })).toBeTrue()
})
