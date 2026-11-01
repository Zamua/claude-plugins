// Hands an operator message sent from the app to its topic's agent as an
// operator turn, the same as one from Telegram. The app's sender was verified
// (an enrolled device's signature from an allowed node), so the turn carries the
// operator's id, marked `origin: app` with the device and the ledger entry's
// hash, which verify.py checks against the ledger.
import type { InboundMsg } from '../topics/state'
import type { DeliverAppMessage } from './api'

export type AppDeliveryPorts = {
  operatorId: string
  chatId: string
  /** True when the topic takes no agent turns from here: a locked harness, or the square. */
  refuses: (topic: string) => string | undefined
  saveImage: (bytes: Uint8Array, extension: string) => string
  ensureSession: (topic: string) => void
  enqueue: (topic: string, msg: InboundMsg) => void
  /** Posts into the Telegram topic, so Telegram stays the full record; gives the post's id. */
  echo: (topic: string, text: string) => Promise<number | undefined>
}

export function appDelivery(ports: AppDeliveryPorts): DeliverAppMessage {
  return async ({ topic, message, images, ledgerHash, deviceId }) => {
    const refusal = ports.refuses(topic)
    if (refusal) return { delivered: false, reason: refusal }
    const paths = images.map(image => ports.saveImage(image.bytes, image.mime === 'image/png' ? 'png' : 'jpg'))
    const imageNote = images.length ? ` [${images.length} image${images.length === 1 ? '' : 's'}]` : ''
    const echoId = await ports.echo(topic, `You (app): ${message.text}${imageNote}`).catch(() => undefined)
    const more = paths.length > 1 ? `\n(more images: ${paths.slice(1).join(', ')})` : ''
    ports.ensureSession(topic)
    ports.enqueue(topic, {
      content: `${message.text}${more}`,
      meta: {
        chat_id: ports.chatId,
        ...(echoId !== undefined ? { message_id: String(echoId) } : {}),
        user: 'operator (app)',
        user_id: ports.operatorId,
        ts: message.at,
        ...(topic !== 'general' ? { message_thread_id: topic } : {}),
        ...(paths[0] ? { image_path: paths[0] } : {}),
        origin: 'app',
        device: deviceId,
        ledger: ledgerHash,
      },
    })
    return { delivered: true }
  }
}
