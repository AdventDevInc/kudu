import { lstat, readdir, unlink } from 'fs/promises'
import { basename, dirname, join } from 'path'

const INFO_SUFFIX = '.trashinfo'

/**
 * The freedesktop.org trash spec has the .trashinfo written before the file is
 * moved into `files/`, so a trash operation in flight briefly looks orphaned.
 */
const IN_FLIGHT_MS = 60_000

/**
 * Remove freedesktop.org trash metadata whose trashed item is gone.
 *
 * Each `info/<name>.trashinfo` records the original path and deletion date of
 * `files/<name>`. Emptying `files/` leaves those records behind, so the trash
 * keeps a list of what was deleted and where it came from. Only records whose
 * item no longer exists are removed; anything that can't be checked is kept.
 * A no-op for trash folders that don't follow the spec (e.g. macOS ~/.Trash).
 */
export async function pruneOrphanedTrashInfo(
  trashFilesPath: string,
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
    try {
      await lstat(join(trashFilesPath, name.slice(0, -INFO_SUFFIX.length)))
      continue
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue
    }
    const infoPath = join(infoDir, name)
    try {
      const info = await lstat(infoPath)
      if (!info.isFile() || now - info.mtimeMs < IN_FLIGHT_MS) continue
      await unlink(infoPath)
      removed++
    } catch {
      // Keep records that can't be inspected or removed.
    }
  }
  return removed
}
