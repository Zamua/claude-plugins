import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'

type ManagedLinks = { version: 1; links: Record<string, string> }

export function claudePluginSkillRoots(
  settingsFile: string,
  installedPluginsFile: string,
  excludedPluginNames = new Set<string>(),
): string[] {
  try {
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as any
    const installed = JSON.parse(readFileSync(installedPluginsFile, 'utf8')) as any
    const roots: string[] = []
    for (const [identity, enabled] of Object.entries(settings.enabledPlugins ?? {})) {
      const name = identity.split('@')[0]
      if (enabled !== true || excludedPluginNames.has(name)) continue
      const records = installed.plugins?.[identity]
      const installPath = Array.isArray(records) ? records.at(-1)?.installPath : undefined
      const skills = typeof installPath === 'string' ? join(installPath, 'skills') : ''
      if (skills && existsSync(skills)) roots.push(skills)
    }
    return roots
  } catch {
    return []
  }
}

function priorLinks(manifest: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as ManagedLinks
    return parsed.version === 1 && parsed.links && typeof parsed.links === 'object'
      ? parsed.links
      : {}
  } catch {
    return {}
  }
}

export function syncAntigravitySkills(
  targetDir: string,
  sourceRoots: string[],
): { linked: string[]; skipped: string[] } {
  mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  const manifest = join(targetDir, '.telegram-interop.json')
  const previous = priorLinks(manifest)

  // Remove only links that this adapter created and that still point at the
  // recorded source. Native/user-managed Antigravity skills are untouchable.
  for (const [name, source] of Object.entries(previous)) {
    const destination = join(targetDir, name)
    try {
      if (lstatSync(destination).isSymbolicLink() && readlinkSync(destination) === source) {
        unlinkSync(destination)
      }
    } catch {}
  }

  const candidates = new Map<string, string>()
  for (const root of sourceRoots) {
    let names: string[] = []
    try { names = readdirSync(root) } catch { continue }
    for (const name of names.sort()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || candidates.has(name)) continue
      const source = join(root, name)
      if (existsSync(join(source, 'SKILL.md'))) candidates.set(name, source)
    }
  }

  const linked: string[] = []
  const skipped: string[] = []
  const links: Record<string, string> = {}
  for (const [name, source] of candidates) {
    const destination = join(targetDir, name)
    if (existsSync(destination)) {
      skipped.push(name)
      continue
    }
    symlinkSync(source, destination)
    links[name] = source
    linked.push(name)
  }

  const temp = `${manifest}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify({ version: 1, links }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, manifest)
  return { linked, skipped }
}
