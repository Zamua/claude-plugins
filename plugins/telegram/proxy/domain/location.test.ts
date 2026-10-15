import { describe, expect, test } from 'bun:test'
import { describeLocation, describeVenue, mapsLink } from './location'

const here = { latitude: 38.770123456, longitude: -77.134567891 }

describe('describeLocation', () => {
  test('a pinned location carries coordinates and a maps link', () => {
    expect(describeLocation(here)).toBe(
      '(location: 38.770123, -77.134568) https://www.google.com/maps?q=38.770123,-77.134568',
    )
  })

  test('accuracy is shown in whole meters', () => {
    expect(describeLocation({ ...here, horizontal_accuracy: 19.6 })).toContain('±20 m')
  })

  test('a live location names its duration', () => {
    expect(describeLocation({ ...here, live_period: 900 })).toContain('live for 15 min')
    expect(describeLocation({ ...here, live_period: 28800 })).toContain('live for 8 h')
    expect(describeLocation({ ...here, live_period: 0x7fffffff })).toContain('live until stopped')
  })
})

describe('describeVenue', () => {
  test('a venue names its place and address before the coordinates', () => {
    expect(describeVenue({ location: here, title: 'Coffee', address: '1 Main St' })).toBe(
      '(venue: Coffee, 1 Main St, at 38.770123, -77.134568) https://www.google.com/maps?q=38.770123,-77.134568',
    )
  })

  test('a venue without names still gives coordinates', () => {
    expect(describeVenue({ location: here, title: ' ' })).toBe(`(venue: at 38.770123, -77.134568) ${mapsLink(here)}`)
  })
})
