import { constants } from 'fs'
import { chmod, copyFile, lstat, rename, rm, utimes } from 'fs/promises'

/**
 * Move a regular file to `dest`.
 *
 * `rename` cannot cross filesystems: it fails with EXDEV when the source and
 * the destination are on different mounts, for example a file in a tmpfs
 * `/tmp` or `/dev/shm` moved under the user's home, or a file on another
 * drive. In that case the file is copied (keeping its mode and timestamps)
 * and the source removed. The copy never overwrites an existing `dest`, and if
 * the source can't be removed the copy is deleted again, so a failed move
 * leaves the file where it was.
 */
export async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }

  // copyFile follows symlinks, which would copy the target and then only
  // remove the link. Only regular files are moved this way.
  const info = await lstat(src)
  if (!info.isFile()) throw new Error(`Cannot move ${src} across filesystems: not a regular file`)

  await copyFile(src, dest, constants.COPYFILE_EXCL)
  try {
    await chmod(dest, info.mode)
    await utimes(dest, info.atime, info.mtime)
    await rm(src)
  } catch (err) {
    await rm(dest, { force: true })
    throw err
  }
}
