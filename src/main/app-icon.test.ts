import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

// Windows picks the window, taskbar and Alt+Tab icons from icon.ico at the
// exact pixel size for the display's scaling. A missing size gets resampled
// from a neighbour and looks blurry (issue #508), so every size used between
// 100% and 300% scaling must be present.
const SMALL_ICON_SIZES = [16, 20, 24, 28, 32, 36, 40, 48] // SM_CXSMICON, title bar
const TASKBAR_ICON_SIZES = [24, 30, 36, 42, 48, 60, 72] // Windows 11 taskbar buttons
const LARGE_ICON_SIZES = [32, 40, 48, 56, 64, 80, 96] // SM_CXICON, Alt+Tab
const REQUIRED_SIZES = [
  ...new Set([...SMALL_ICON_SIZES, ...TASKBAR_ICON_SIZES, ...LARGE_ICON_SIZES, 256])
]

function readIcoSizes(path: string): number[] {
  const ico = readFileSync(path)
  expect(ico.readUInt16LE(0)).toBe(0)
  expect(ico.readUInt16LE(2)).toBe(1)

  const sizes: number[] = []
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const entry = 6 + i * 16
    // A stored dimension of 0 means 256.
    const width = ico[entry] || 256
    const height = ico[entry + 1] || 256
    expect(height).toBe(width)
    expect(ico.readUInt16LE(entry + 6)).toBe(32)
    sizes.push(width)
  }
  return sizes
}

describe('Windows app icon', () => {
  it('contains a native image for every Windows DPI scaling size', () => {
    const sizes = readIcoSizes(join(process.cwd(), 'resources', 'icon.ico'))

    for (const size of REQUIRED_SIZES) {
      expect(sizes, `missing ${size}x${size}`).toContain(size)
    }
  })
})
