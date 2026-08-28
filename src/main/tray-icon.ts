import { readFileSync } from 'fs'
import { join } from 'path'

export const WINDOWS_TRAY_ICON_REPRESENTATIONS = [
  { size: 16, scaleFactor: 1 },
  { size: 20, scaleFactor: 1.25 },
  { size: 24, scaleFactor: 1.5 },
  { size: 28, scaleFactor: 1.75 },
  { size: 32, scaleFactor: 2 },
  { size: 36, scaleFactor: 2.25 },
  { size: 40, scaleFactor: 2.5 },
  { size: 48, scaleFactor: 3 },
] as const

interface TrayNativeImage {
  addRepresentation(options: {
    scaleFactor: number
    width: number
    height: number
    buffer: Buffer
  }): void
}

interface NativeImageFactory<T extends TrayNativeImage> {
  createEmpty(): T
}

export function createWindowsTrayIcon<T extends TrayNativeImage>(
  nativeImageFactory: NativeImageFactory<T>,
  iconsDir: string,
  readIcon: (path: string) => Buffer = readFileSync,
): T {
  const trayIcon = nativeImageFactory.createEmpty()

  for (const { size, scaleFactor } of WINDOWS_TRAY_ICON_REPRESENTATIONS) {
    trayIcon.addRepresentation({
      scaleFactor,
      width: size,
      height: size,
      buffer: readIcon(join(iconsDir, `${size}x${size}.png`)),
    })
  }

  return trayIcon
}
