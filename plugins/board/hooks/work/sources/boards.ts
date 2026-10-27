import type { EngineInterface } from 'claude-code'

import { messageOf } from '../../kit'
import { qualify, URGENCY } from '../model'
import type { Item, ItemLink, SourceAnswer, Status } from '../model'

type BoardItem = {
  id?: string
  title?: string
  section?: string
  detail?: string
  source?: string
  source_label?: string
  links?: ItemLink[]
  workspace?: string
}

/**
 * Another board's items as Items under a local Item, by `boards: { <board id>: <Item id> }`, read from that board's
 * file each refresh. Its archived items stay off, as they do on that board.
 */
export async function readBoards(
  $: EngineInterface,
  under: Record<string, string>,
  paths: Record<string, string>,
): Promise<SourceAnswer> {
  const items: Item[] = []
  const errors: string[] = []
  for (const [board, parent] of Object.entries(under)) {
    const path = paths[board]
    if (!path) {
      errors.push(`boards.json has no board ${board} to show under ${parent}.`)
      continue
    }
    try {
      if (!(await $.fs.exists(path))) continue
      const file = JSON.parse(await $.fs.read(path)) as { items?: BoardItem[] }
      for (const one of file.items ?? []) {
        if (!one.id || !one.title || one.section === 'archive') continue
        const status: Status = URGENCY.includes(one.section as Status) ? (one.section as Status) : 'done'
        const links = [
          ...(one.source ? [{ url: one.source, ...(one.source_label && { label: one.source_label }) }] : []),
          ...(one.links ?? []).filter(link => link?.url && link.url !== one.source),
        ]
        items.push({
          id: `board:${board}:${one.id}`,
          source: board,
          kind: 'Task',
          title: one.title,
          shape: 'outcome',
          status,
          isStatusLive: true,
          parent: qualify(parent),
          aliases: one.workspace ? [one.workspace] : [],
          ...(one.detail && { detail: one.detail }),
          links,
        })
      }
    } catch (err) {
      errors.push(`${board} board: ${messageOf(err)}`)
    }
  }

  return { items, ...(errors.length > 0 && { error: errors.join(' ') }) }
}
