// Meta flags on turns the proxy itself enqueues. hooks/stop-reply-guard.py reads
// some of them from the rendered <channel> attributes to let a turn end without
// a reply, so a change here must keep that hook's matches true.
export const SQUARE_META = { square: '1' } as const
export const SECRET_DROP_META = { secret_drop: '1' } as const
export const RELAUNCH_META = { relaunch: '1' } as const
export const reminderMeta = (hasFollowUp: boolean) => ({ reminder: hasFollowUp ? 'act' : 'notice' }) as const
