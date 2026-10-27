import type { EngineInterface } from 'claude-code'

type SessionRecord = { sessionId?: string; name?: string; updatedAt?: number }

export type HarnessInfo = { messageName?: string; lastActive?: number }

/**
 * What Claude Code's own session records say of each agent: the name its messaging addresses it by, and when it last
 * changed. A record lives in `sessions/<pid>.json` under the config directory, so it is found by its `sessionId`.
 */
export async function claudeInfo($: EngineInterface, harnessIds: string[]): Promise<Map<string, HarnessInfo>> {
  const out = new Map<string, HarnessInfo>()
  const wanted = new Set(harnessIds)
  if (wanted.size === 0) return out
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
  const dir = `${config}/sessions`
  if (!(await $.fs.exists(dir))) return out
  for (const file of await $.fs.list(dir)) {
    if (file.kind !== 'file' || !file.name.endsWith('.json')) continue
    try {
      const record = JSON.parse(await $.fs.read(`${dir}/${file.name}`)) as SessionRecord
      if (!record.sessionId || !wanted.has(record.sessionId)) continue
      out.set(record.sessionId, {
        ...(record.name && { messageName: record.name }),
        ...(typeof record.updatedAt === 'number' && { lastActive: record.updatedAt }),
      })
    } catch {
      // A record mid-write reads as missing until the next refresh
    }
  }

  return out
}

/** The arguments Claude Code starts with, from `harnesses.claude.args`. */
export function claudeArgs(config: unknown): string[] {
  const args = (config as { args?: unknown } | undefined)?.args

  return Array.isArray(args) ? args.filter((one): one is string => typeof one === 'string') : []
}
