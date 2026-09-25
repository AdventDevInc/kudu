import { stat } from 'fs/promises'
import path from 'path'

export interface ShortcutInfo {
  path: string
  targetPath: string | null
}

/**
 * What the filesystem says about a path. `unknown` covers anything other than
 * a definite "not there" — permission errors, timeouts, unreachable media — so
 * a shortcut is never flagged just because its target couldn't be inspected.
 */
export type PathState = 'present' | 'missing' | 'unknown'

/**
 * Asynchronous so a slow or disconnected network drive never blocks the
 * Electron main process; the lookup runs on libuv's thread pool.
 */
export async function probePath(p: string): Promise<PathState> {
  try {
    // Follow links: a launcher whose target is a dangling symlink is broken.
    await stat(p)
    return 'present'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown'
  }
}

/** Windows Start Menu subdirectories that contain built-in OS shortcuts */
export const WIN_SYSTEM_SUBDIRS =
  /\\(System Tools|Administrative Tools|Accessibility|Windows PowerShell|Windows System|Windows Accessories)\\/i

const WIN_DRIVE_PATH = /^[a-z]:[\\/]/i
const WIN_UNC_ROOT = /^(\\\\[^\\]+\\[^\\]+)(\\|$)/

/**
 * The root a Windows target lives under: the drive (`D:\`) or the UNC share
 * (`\\server\share`). If that root isn't reachable — a USB stick that isn't
 * plugged in, a mapped drive or share that's offline — the target's absence
 * says nothing about whether the shortcut is broken.
 */
function winTargetRoot(target: string): string | null {
  if (WIN_DRIVE_PATH.test(target)) return path.win32.parse(target).root
  const unc = WIN_UNC_ROOT.exec(target)
  return unc ? unc[1] : null
}

/**
 * Shortcuts that store `%ProgramFiles%` resolve to the 64-bit folder when read
 * from a 64-bit process, even when the app was installed to the x86 one. The
 * shell falls back between the two when launching, so check both before
 * calling the target missing.
 */
function programFilesAlternates(target: string): string[] {
  const x86 = /^([a-z]:\\)Program Files \(x86\)\\/i
  const x64 = /^([a-z]:\\)Program Files\\/i
  if (x86.test(target)) return [target.replace(x86, '$1Program Files\\')]
  if (x64.test(target)) return [target.replace(x64, '$1Program Files (x86)\\')]
  return []
}

/**
 * The paths `isShortcutTargetBroken` may look up, in the order it needs them.
 * On Windows nothing past the drive/share root is touched unless it is reachable.
 */
function candidatePaths(info: ShortcutInfo, platform: NodeJS.Platform): string[][] {
  if (!info.targetPath) return []
  if (platform !== 'win32') return [[info.targetPath]]
  const root = winTargetRoot(info.targetPath)
  return root ? [[root], [info.targetPath, ...programFilesAlternates(info.targetPath)]] : []
}

/**
 * Look up everything the decision needs asynchronously, then decide. `probe`
 * is usually memoised by the caller so many shortcuts on one drive share a
 * single root lookup.
 */
export async function checkShortcutTarget(
  info: ShortcutInfo,
  platform: NodeJS.Platform,
  probe: (p: string) => Promise<PathState> = probePath
): Promise<boolean> {
  const states = new Map<string, PathState>()
  for (const [i, batch] of candidatePaths(info, platform).entries()) {
    // Stop before touching anything on an unreachable drive or share.
    if (i > 0 && [...states.values()].some((state) => state !== 'present')) break
    for (const [path, state] of await Promise.all(
      batch.map(async (path) => [path, await probe(path)] as const)
    ))
      states.set(path, state)
  }
  return isShortcutTargetBroken(info, platform, (p) => states.get(p) ?? 'unknown')
}

/** The decision itself, given a synchronous view of what the filesystem said. */
export function isShortcutTargetBroken(
  info: ShortcutInfo,
  platform: NodeJS.Platform,
  probe: (p: string) => PathState
): boolean {
  if (platform === 'win32') {
    // Never flag shortcuts in built-in Windows Start Menu subdirectories
    if (WIN_SYSTEM_SUBDIRS.test(info.path)) return false
    // A .lnk with a stored filesystem path returns it from WScript.Shell even
    // when the file is gone, so an empty TargetPath means the shortcut targets
    // a shell namespace item (File Explorer, This PC, Recycle Bin, etc.) which
    // we can't verify via the filesystem — leave it alone.
    if (!info.targetPath) return false
    // Never flag shortcuts pointing to Windows system executables
    if (/\\Windows\\/i.test(info.targetPath)) return false
    // Skip targets that reference Windows Apps store folder (UWP apps)
    if (/\\WindowsApps\\/i.test(info.targetPath)) return false
    // Only plain drive and UNC paths can be checked on disk; anything else
    // (shell:, protocol handlers, app IDs) is left alone.
    const root = winTargetRoot(info.targetPath)
    if (!root || probe(root) !== 'present') return false
    if (probe(info.targetPath) !== 'missing') return false
    return programFilesAlternates(info.targetPath).every((alt) => probe(alt) === 'missing')
  }
  // If we couldn't resolve the target at all, consider it broken
  if (!info.targetPath) return true
  // Empty target
  if (info.targetPath.trim() === '') return true
  // Skip URLs and other protocol-style targets
  if (/^[a-z][a-z0-9+.-]*:/i.test(info.targetPath)) return false
  // Linux: if the target was resolved via PATH (not an absolute path), it's valid
  if (!info.targetPath.startsWith('/')) return false
  // Check if the target exists on disk
  return probe(info.targetPath) === 'missing'
}
