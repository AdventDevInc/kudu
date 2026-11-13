import { posix, win32 } from 'path'

/** Reject ambiguous paths and volume/share roots before any destructive work. */
export function isDeletionRoot(path: string): boolean {
  if (!path || path.includes('\0')) return true
  // Device namespaces can alias volumes; never interpret them as cleanup paths.
  if (/^[\\/]{2}[?.]/.test(path)) return true
  if (/^[a-z]:/i.test(path) || path.includes('\\') || path.startsWith('//')) {
    if (!win32.isAbsolute(path) || /^[a-z]:[^\\/]/i.test(path)) return true
    const normalized = win32
      .normalize(path)
      .replace(/[\\/]+$/, '')
      .toLowerCase()
    return (
      normalized ===
      win32
        .parse(win32.normalize(path))
        .root.replace(/[\\/]+$/, '')
        .toLowerCase()
    )
  }
  if (!posix.isAbsolute(path)) return true
  return posix.normalize(path) === '/' || /^\/\/[^/]+\/[^/]+\/?$/.test(path)
}
