import type {
  AntigravityModel,
  AntigravityRoute,
} from '../domain/antigravity-topic'
import type { AntigravityEffort } from '../domain/antigravity-topic'
import type {
  AntigravityCatalogPort,
  AntigravityUsageWindow,
} from '../application/antigravity-ports'
import { nodeProcessRunner } from './process-runner'
import type { ProcessRunner } from './process-runner'

export type {
  AntigravityUsageWindow,
} from '../application/antigravity-ports'

const EFFORTS: AntigravityEffort[] = ['low', 'medium', 'high']

export function parseAntigravityModels(output: string): AntigravityModel[] {
  const groups = new Map<string, {
    label: string
    variants: Partial<Record<AntigravityEffort, string>>
    concrete?: string
  }>()

  for (const line of output.split(/\r?\n/)) {
    const [rawId, rawLabel] = line.split('\t')
    const id = rawId?.trim()
    const label = rawLabel?.trim()
    if (!id || !label) continue

    const idEffort = id.match(/-(low|medium|high)$/)?.[1] as AntigravityEffort | undefined
    const labelEffort = label.match(/ \((Low|Medium|High)\)$/)?.[1]?.toLowerCase() as
      | AntigravityEffort
      | undefined
    const isConcreteVariant = idEffort && labelEffort === idEffort
    const baseId = isConcreteVariant ? id.slice(0, -(idEffort.length + 1)) : id
    const baseLabel = isConcreteVariant ? label.replace(/ \((Low|Medium|High)\)$/, '') : label
    const group = groups.get(baseId) ?? { label: baseLabel, variants: {} }
    if (isConcreteVariant) group.variants[idEffort] = id
    else group.concrete = id
    groups.set(baseId, group)
  }

  return [...groups.entries()].map(([id, group]) => {
    const variantEfforts = EFFORTS.filter(effort => group.variants[effort])
    const efforts = variantEfforts.length ? variantEfforts : [...EFFORTS]
    const defaultEffort = efforts.includes('medium') ? 'medium' : efforts[0]
    return {
      id: group.concrete ?? id,
      label: group.label,
      variants: group.variants,
      efforts,
      defaultEffort,
    }
  })
}

export function parseAntigravityUsage(output: string): AntigravityUsageWindow[] {
  const windows: AntigravityUsageWindow[] = []
  const textPattern = /^(.+?)\s+(weekly|five-hour):\s+(\d+(?:\.\d+)?)%\s+remaining\s+\(resets\s+([^\)]+)\)$/i
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    const tab = line.split('\t')
    const match = line.match(textPattern)
    const pool = tab.length === 4 ? tab[0] : match?.[1]
    const window = tab.length === 4
      ? tab[1].replace(/ Limit Remaining$/i, '').replace(/Five Hour/i, 'five-hour').toLowerCase()
      : match?.[2].toLowerCase()
    const remaining = tab.length === 4 ? tab[2].replace(/%$/, '') : match?.[3]
    const reset = tab.length === 4 ? tab[3] : match?.[4]
    if (!pool || !window || !remaining || !reset) continue
    const resetsAt = Date.parse(reset)
    if (!Number.isFinite(resetsAt)) continue
    windows.push({
      pool,
      window,
      remainingPercent: Number(remaining),
      resetsAt,
    })
  }
  return windows
}

export class AntigravityCli implements AntigravityCatalogPort {
  constructor(
    private readonly binary: string,
    private readonly cwd: string,
    private readonly run: ProcessRunner = nodeProcessRunner,
  ) {}

  async models(): Promise<AntigravityModel[]> {
    const result = await this.run(this.binary, ['models'], { cwd: this.cwd, timeout: 60_000 })
    const models = parseAntigravityModels(result.stdout)
    if (!models.length) throw new Error('Antigravity returned an empty model catalog')
    return models
  }

  async usage(): Promise<AntigravityUsageWindow[]> {
    const result = await this.run(this.binary, ['-p', '/usage'], { cwd: this.cwd, timeout: 60_000 })
    return parseAntigravityUsage(result.stdout)
  }
}

export function routeLabel(route: AntigravityRoute): string {
  return `Google / Antigravity · ${route.modelLabel} · ${route.effort}`
}
