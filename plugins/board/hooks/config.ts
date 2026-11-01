import type { FileBoardSpec, LinkPair } from './views/file'
import type { RolloutSpec } from './views/rollout'
import type { PlacedBoard, WorkSpec } from './work/view'

/** `boards.json`, sorted into the boards each layout draws. */
export type BoardsConfig = {
  labels: Record<string, string>
  pairs: LinkPair[]
  files: FileBoardSpec[]
  rollouts: RolloutSpec[]
  work?: WorkSpec
  /** Boards drawn under an Item of the work view rather than in every session. */
  placed: PlacedBoard[]
  /** Every board id in use, the built-in views first. */
  ids: string[]
}

type Spec = { id: string; path: string; title?: string; layout?: unknown; under?: unknown }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isSpec = (one: unknown): one is Spec =>
  isRecord(one) && typeof one.id === 'string' && /^[a-z0-9-]+$/i.test(one.id) && typeof one.path === 'string'

/**
 * A board whose entry lacks an id or path, or reuses a taken id, is left out; so is a second `model` board, as
 * there is one work model per person. Anything but an object reads as no boards.
 */
export function parseBoardsConfig(raw: unknown, builtIn: readonly string[]): BoardsConfig {
  const config = isRecord(raw) ? raw : {}
  const labels = isRecord(config.link_labels)
    ? Object.fromEntries(Object.entries(config.link_labels).filter((e): e is [string, string] => typeof e[1] === 'string'))
    : {}
  const out: BoardsConfig = {
    labels,
    pairs: Array.isArray(config.link_pairs) ? (config.link_pairs as LinkPair[]) : [],
    files: [],
    rollouts: [],
    placed: [],
    ids: [...builtIn],
  }
  for (const spec of Array.isArray(config.boards) ? config.boards : []) {
    if (!isSpec(spec) || out.ids.includes(spec.id)) continue
    if (spec.layout === 'model') {
      if (out.work) continue
      out.work = spec as unknown as WorkSpec
    } else {
      if (typeof spec.under === 'string' && spec.under !== '') {
        out.placed.push({ id: spec.id, title: spec.title ?? spec.id, under: spec.under })
      }
      if (spec.layout === 'rollout') out.rollouts.push(spec as RolloutSpec)
      else out.files.push(spec as FileBoardSpec)
    }
    out.ids.push(spec.id)
  }

  return out
}
