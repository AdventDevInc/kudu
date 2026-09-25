import { lstat, readdir, unlink } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'path'

const INFO_SUFFIX = '.trashinfo'

/**
 * The freedesktop.org trash spec has the .trashinfo written before the file is
 * moved into `files/`, so a trash operation in flight briefly looks orphaned.
 */
const IN_FLIGHT_MS = 60_000

/**
 * The top-level trash entries (names directly under `files/`) that the given
 * cleaned paths belonged to. Paths outside the trash are ignored.
 */
export function trashEntryNames(trashFilesPath: string, cleanedPaths: string[]): Set<string> {
  const names = new Set<string>()
  for (const path of cleanedPaths) {
    const rel = relative(trashFilesPath, path)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    names.add(rel.split(sep)[0])
  }
  return names
}

/**
 * Remove freedesktop.org trash metadata whose trashed item is gone.
 *
 * Each `info/<name>.trashinfo` records the original path and deletion date of
 * `files/<name>`. Emptying `files/` leaves those records behind, so the trash
 * keeps a list of what was deleted and where it came from. Only records whose
 * item no longer exists are removed; anything that can't be checked is kept.
 * Records for `cleaned` entries — ones Kudu itself just deleted — are removed
 * at once; other orphans only once they are past the in-flight grace period,
 * since they may belong to a trash operation still in progress.
 * A no-op for trash folders that don't follow the spec (e.g. macOS ~/.Trash).
 */
export async function pruneOrphanedTrashInfo(
  trashFilesPath: string,
  cleaned: ReadonlySet<string> = new Set(),
  now = Date.now()
): Promise<number> {
  if (basename(trashFilesPath) !== 'files') return 0
  const infoDir = join(dirname(trashFilesPath), 'info')

  let names: string[]
  try {
    names = await readdir(infoDir)
  } catch {
    return 0
  }

  let removed = 0
  for (const name of names) {
    if (!name.endsWith(INFO_SUFFIX) || name.length === INFO_SUFFIX.length) continue
    const entry = name.slice(0, -INFO_SUFFIX.length)
    try {
      await lstat(join(trashFilesPath, entry))
      continue
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue
    }
    const infoPath = join(infoDir, name)
    try {
      const info = await lstat(infoPath)
      if (!info.isFile()) continue
      if (!cleaned.has(entry) && now - info.mtimeMs < IN_FLIGHT_MS) continue
      await unlink(infoPath)
      removed++
    } catch {
      // Keep records that can't be inspected or removed.
    }
  }
  return removed
}
