// The one getUpdates consumer of the bot token, kept polling through errors.
import { GrammyError } from 'grammy'
import type { Bot } from 'grammy'
import { GROUP_CHAT_ID, MARKETPLACE, MODEL, SPAWN_DIR } from '../config'
import { log } from '../log'

export function createPolling(bot: Bot) {
  // When polling last started, for /health: a monitor tells "up but deaf" from it.
  let since: number | null = null
  let stopping = false

  // Retries with backoff on any error. bot.catch only handles throws inside
  // update handlers; a rejection of bot.start() itself (ETIMEDOUT/ECONNRESET/DNS
  // or a 409 from a not-yet-drained old poller) would otherwise stop polling
  // for good while the HTTP server stays up.
  async function run(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await bot.start({
          onStart: info => {
            // Do NOT reset `attempt` here. grammy fires onStart AFTER getMe +
            // deleteWebhook but BEFORE the getUpdates that raises a 409, so
            // zeroing the counter here would defeat the backoff on every
            // conflict and busy-loop the API.
            since = Date.now()
            log(
              `polling as @${info.username}; group ${GROUP_CHAT_ID}; spawn dir ${SPAWN_DIR}; ` +
              `marketplace ${MARKETPLACE}; default ultracode off; model ${MODEL || '(account default)'}`,
            )
          },
        })
        return // bot.stop() was called
      } catch (err) {
        if (stopping) return
        // bot.stop() mid-setup rejects with grammy's "Aborted delay".
        if (err instanceof Error && err.message === 'Aborted delay') return
        // The backoff resets only after a stably-up run, so a sustained 409
        // (another poller holding the token) climbs to the give-up threshold.
        const wasStablyUp = since != null && Date.now() - since > 30_000
        since = null
        if (wasStablyUp) attempt = 1
        const is409 = err instanceof GrammyError && err.error_code === 409
        if (is409 && attempt >= 8) {
          log(
            `409 Conflict persists after ${attempt} attempts - another poller is holding ` +
              `the bot token (stray proxy or a second session). Polling gives up; /health will report polling=false.`,
          )
          return
        }
        const delay = Math.min(1000 * attempt, 15000)
        const detail = is409 ? `409 Conflict (another poller holding the token)` : `polling error: ${err}`
        log(`${detail}, retrying in ${delay / 1000}s`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }

  // Ends the poll loop; the current getUpdates may take its long-poll timeout to return.
  function stop(): Promise<void> {
    stopping = true
    return Promise.resolve(bot.stop())
  }

  return { run, stop, since: () => since }
}
