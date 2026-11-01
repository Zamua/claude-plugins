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
