import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { createWindowsTrayIcon, WINDOWS_TRAY_ICON_REPRESENTATIONS } from './tray-icon'

describe('Windows tray icon', () => {
  it('covers every supported Windows scale factor without resampling gaps', () => {
    expect(WINDOWS_TRAY_ICON_REPRESENTATIONS.map(({ scaleFactor }) => scaleFactor)).toEqual([
      1,
      1.25,
      1.5,
      1.75,
      2,
      2.25,
      2.5,
      3,
    ])
  })

  it('bundles a correctly sized PNG for every Windows DPI representation', () => {
    const iconsDir = join(process.cwd(), 'resources', 'icons', 'tray')

    for (const { size } of WINDOWS_TRAY_ICON_REPRESENTATIONS) {
      const png = readFileSync(join(iconsDir, `${size}x${size}.png`))

      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(png.readUInt32BE(16)).toBe(size)
      expect(png.readUInt32BE(20)).toBe(size)
    }
  })

  it('adds each pre-rendered image at its matching scale factor', () => {
    const addRepresentation = vi.fn()
    const readIcon = vi.fn((path: string) => Buffer.from(path))
    const trayIcon = { addRepresentation }

    const result = createWindowsTrayIcon(
      { createEmpty: () => trayIcon },
      'tray-icons',
      readIcon,
    )

    expect(result).toBe(trayIcon)
    expect(addRepresentation).toHaveBeenCalledTimes(WINDOWS_TRAY_ICON_REPRESENTATIONS.length)

    for (const { size, scaleFactor } of WINDOWS_TRAY_ICON_REPRESENTATIONS) {
      const path = join('tray-icons', `${size}x${size}.png`)
      expect(readIcon).toHaveBeenCalledWith(path)
      expect(addRepresentation).toHaveBeenCalledWith({
        scaleFactor,
        width: size,
        height: size,
        buffer: Buffer.from(path),
      })
    }
  })
})
