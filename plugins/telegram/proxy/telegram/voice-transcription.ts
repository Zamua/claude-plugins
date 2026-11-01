import { execFile } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { randomUUID } from 'crypto'
import type { Downloader } from './telegram-files'
import { writeInboxFile } from './telegram-files'

// Inbound voice notes are transcribed locally (whisper.cpp + large-v3-turbo)
// and delivered as text behind a short provenance tag, so a topic-Claude gets
// the words as if typed. Fail-open by design: any missing binary/model or a
// transcription error falls back to the plain "(voice message)" content with
// the attachment meta intact, so the manual download path still works.
// Subprocesses run ASYNC (execFile, not spawnSync): a long clip must not
// stall the event loop that serves every topic's /poll.
export const VOICE_TAG = '[voice note, auto-transcribed; may contain errors]'

// Vocabulary bias for the decoder. Whisper conditions on this text, so naming
// the stack's jargon fixes the words a general model reliably mangles:
// measured on synthesized speech, "kubectl"->"cubectal", "traefik"->"Trifik",
// "502"->"500 too", "namespace"->"namaspace". The glossary fixed most of them
// with no model change. Keep it SHORT - whisper's prompt window is ~224
// tokens, and a bloated list dilutes the bias rather than sharpening it.
// A bare word list is NOT enough for terms whose spoken form differs from the
// written one: "CLAUDE.md" is said "claude dot em dee", and listing the token
// alone still produced "clot md". Embedding the term in a natural SENTENCE
// fixed it, so the prompt ends with prose, not just commas.
export const DEFAULT_VOICE_GLOSSARY = (
  [
    'e2e', 'CI', 'PR', 'repo', 'staging', 'prod', 'semver', 'ghcr', 'MCP', 'API',
    'transcription', 'glossary', 'CLI', 'JSON', 'YAML', 'regex', 'ripgrep',
    'async', 'await', 'TODO', 'kubectl', 'namespace', 'k3s', 'traefik', 'nginx',
    'MinIO', 'podman', 'colima', 'tmux', 'launchd', 'pm2', 'caddy', 'tailscale',
    'herdr', 'PostgreSQL', 'SQLite', 'slatedb', 'Hetzner', 'Oracle',
    'Cloudflare', 'OpenTofu', 'ansible', 'prepcards',
    'boardtogether', 'pokerchips', 'jamshelf', 'shale', 'whisper',
    'Claude', 'opus', 'sonnet', 'fable',
  ].join(', ')
  // Terms whose SPOKEN form differs from the written one need a sentence, not a
  // list entry: "hostthis" is said "host this" and came back as "hostess" while
  // sitting in the list above, and "celld" is said "cell dee".
  + '. Update the CLAUDE.md file, run the e2e tests, then check the CI logs.'
  + ' Deploy hostthis to staging, then migrate hostthis onto celld and check the celld cells.'
)

function run(bin: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout))
    })
  })
}

export type VoiceSettings = { enabled: boolean; ffmpeg: string; whisper: string; model: string; glossary: string }

// ffmpeg, whisper-cli and the model must all be present; a missing one turns transcription off, never fails a message.
function voiceReady(voice: VoiceSettings, log: (m: string) => void): boolean {
  if (!voice.enabled) return false
  for (const [what, p] of [['ffmpeg', voice.ffmpeg], ['whisper-cli', voice.whisper], ['model', voice.model]] as const) {
    if (!existsSync(p)) {
      log(`voice transcription skipped: ${what} not found at ${p}`)
      return false
    }
  }
  return true
}

async function transcribeFile(voice: VoiceSettings, audio: string, log: (m: string) => void): Promise<string | null> {
  const wav = `${audio}.16k.wav`
  try {
    const ff = await run(voice.ffmpeg, ['-y', '-v', 'error', '-i', audio, '-ar', '16000', '-ac', '1', wav], 30_000)
    if (ff === null) {
      log('voice transcription: ffmpeg failed')
      return null
    }
    const whisperArgs = ['-m', voice.model, '-f', wav, '--no-timestamps']
    if (voice.glossary.trim()) whisperArgs.push('--prompt', voice.glossary)
    const out = await run(voice.whisper, whisperArgs, 120_000)
    if (out === null) {
      log('voice transcription: whisper-cli failed')
      return null
    }
    const text = out.trim()
    return text || null
  } finally {
    try { rmSync(wav) } catch {}
  }
}

export async function transcribeVoice(
  voice: VoiceSettings,
  downloadFile: Downloader,
  fileId: string,
  log: (m: string) => void,
): Promise<string | null> {
  if (!voiceReady(voice, log)) return null
  const oga = await downloadFile(fileId)
  if (!oga) return null
  try {
    return await transcribeFile(voice, oga, log)
  } finally {
    try { rmSync(oga) } catch {}
  }
}

/** Transcribes a recording uploaded to the proxy; it is kept in `inboxDir` only while transcribing. */
export async function transcribeAudio(
  voice: VoiceSettings,
  inboxDir: string,
  audio: Uint8Array,
  log: (m: string) => void,
): Promise<string | null> {
  if (!voiceReady(voice, log)) return null
  const path = writeInboxFile(inboxDir, audio, 'audio', `audio-${randomUUID().slice(0, 8)}`)
  try {
    return await transcribeFile(voice, path, log)
  } finally {
    try { rmSync(path) } catch {}
  }
}
