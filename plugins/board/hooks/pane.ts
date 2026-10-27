import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

export const PANE = 'board'
export const TITLE = 'Board'

const selected = atom({ plugin: 'board', key: 'selected' } as const, '')
const isDismissed = atom({ plugin: 'board', key: 'isDismissed' } as const, false)

/** Switches the pane to a view the person asked for, opening the pane if it is closed. */
export async function selectView($: EngineInterface, view: string) {
  await update($, selected, () => view)
  await update($, isDismissed, () => false)
  await $.ui.open({ id: PANE, title: TITLE })
}

/** Opens the pane on a view, unless the person closed the pane or it is already open on some view. */
export async function showView($: EngineInterface, view: string) {
  if (await read($, isDismissed)) return
  if ((await $.ui.panes()).some(p => p.id === PANE)) return
  await update($, selected, () => view)
  await $.ui.open({ id: PANE, title: TITLE })
}
