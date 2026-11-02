export function environmentFlag(
  value: string | undefined,
  fallback: boolean,
  onInvalid?: (value: string) => void,
): boolean {
  const normalized = (value ?? '').trim().toLowerCase()
  if (normalized === '') return fallback
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  onInvalid?.(value!)
  return fallback
}

/** A switch that only an exact off turns off and only an exact on (or nothing) leaves on: a value it cannot read is off. */
export function killSwitch(value: string | undefined, onInvalid?: (value: string) => void): boolean {
  let unreadable = false
  const on = environmentFlag(value, true, v => {
    unreadable = true
    onInvalid?.(v)
  })
  return on && !unreadable
}
