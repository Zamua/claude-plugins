// Telegram location and venue messages, rendered as the text a topic receives.

export type TelegramLocation = {
  latitude: number
  longitude: number
  horizontal_accuracy?: number
  live_period?: number
}

export type TelegramVenue = {
  location: TelegramLocation
  title?: string
  address?: string
}

// Telegram's live_period for a live location shared until stopped.
const LIVE_INDEFINITELY = 0x7fffffff

const coordinate = (n: number) => n.toFixed(6)

export function mapsLink(location: TelegramLocation): string {
  return `https://www.google.com/maps?q=${coordinate(location.latitude)},${coordinate(location.longitude)}`
}

function liveFor(seconds: number): string {
  if (seconds >= LIVE_INDEFINITELY) return 'live until stopped'
  const minutes = Math.round(seconds / 60)
  return minutes >= 60 && minutes % 60 === 0 ? `live for ${minutes / 60} h` : `live for ${minutes} min`
}

export function describeLocation(location: TelegramLocation): string {
  const parts = [`${coordinate(location.latitude)}, ${coordinate(location.longitude)}`]
  if (location.horizontal_accuracy) parts.push(`±${Math.round(location.horizontal_accuracy)} m`)
  if (location.live_period) parts.push(liveFor(location.live_period))
  return `(location: ${parts.join(', ')}) ${mapsLink(location)}`
}

export function describeVenue(venue: TelegramVenue): string {
  const names = [venue.title, venue.address].filter(s => s && s.trim()).join(', ')
  const at = `${coordinate(venue.location.latitude)}, ${coordinate(venue.location.longitude)}`
  return `(venue: ${names ? `${names}, ` : ''}at ${at}) ${mapsLink(venue.location)}`
}
