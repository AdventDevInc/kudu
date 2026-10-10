export type DownloadKind = 'installer' | 'archive' | 'diskImage' | 'other'
export interface DownloadEntry {
  id: string
  name: string
  size: number
  modified: number
  kind: DownloadKind
}
export interface DownloadsScanResult {
  scanId: string
  directory: string
  files: DownloadEntry[]
  skipped: number
  limited: boolean
}
export interface DownloadsTrashResult {
  trashedIds: string[]
  skippedIds: string[]
}
export function downloadKind(name: string): DownloadKind {
  if (/\.(exe|msi|msix|msixbundle|appx|appxbundle|pkg|deb|rpm|appimage)$/i.test(name))
    return 'installer'
  if (/\.(zip|7z|rar|tar|gz|bz2|xz|tgz|tbz2)$/i.test(name)) return 'archive'
  if (/\.(iso|dmg|img)$/i.test(name)) return 'diskImage'
  return 'other'
}
