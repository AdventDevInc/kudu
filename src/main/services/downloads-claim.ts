import { constants } from 'fs'
import type { BigIntStats } from 'fs'
import { link, lstat, mkdtemp, open, realpath, rename, rmdir, unlink } from 'fs/promises'
import { basename, join } from 'path'
import { validateStorageRoot } from './storage-scan'

export type DownloadIdentity = Pick<
  BigIntStats,
  'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs' | 'birthtimeNs' | 'nlink'
>
export const sameDownloadIdentity = (a: DownloadIdentity, b: DownloadIdentity): boolean =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.nlink === b.nlink &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.birthtimeNs === b.birthtimeNs
const stableIdentity = (a: DownloadIdentity, b: DownloadIdentity): boolean =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.nlink === b.nlink &&
  a.mtimeNs === b.mtimeNs &&
  a.birthtimeNs === b.birthtimeNs

/** Claim names atomically before asking the path-based OS Trash API to act on them.
 * One private staging folder per batch keeps the original filenames and remains
 * available as the OS Trash restore destination after a successful move.
 */
export class DownloadsClaimBatch {
  private directory: string | null = null
  private directoryIdentity: BigIntStats | null = null
  private trashed = false
  constructor(
    private readonly root: string,
    private readonly rootUnchanged: () => Promise<boolean>,
    private readonly trash: (path: string) => Promise<void>,
    private readonly allowed: (original: string, claimed: string) => Promise<boolean> = async () =>
      true,
    private readonly operations = { rename, link }
  ) {}

  private async stageDirectory(): Promise<string> {
    if (!(await this.rootUnchanged())) throw new Error('Downloads changed')
    if (!this.directory) {
      this.directory = await mkdtemp(join(this.root, 'Kudu Downloads Recovery-'))
      this.directoryIdentity = await lstat(this.directory, { bigint: true })
    }
    await this.checkDirectory()
    return this.directory
  }

  private async checkDirectory(): Promise<void> {
    if (!this.directory || !this.directoryIdentity || !(await this.rootUnchanged()))
      throw new Error('Downloads changed')
    await validateStorageRoot(this.directory)
    const current = await lstat(this.directory, { bigint: true })
    if (
      current.dev !== this.directoryIdentity.dev ||
      current.ino !== this.directoryIdentity.ino ||
      current.birthtimeNs !== this.directoryIdentity.birthtimeNs ||
      (await realpath(this.directory)) !== this.directory
    )
      throw new Error('Recovery folder changed')
  }

  async move(
    path: string,
    expected: DownloadIdentity
  ): Promise<{ trashed: boolean; recoveryPath?: string }> {
    let claimed: string | null = null
    // Hold the original inode across the claim, so rename cannot make a different
    // file pass merely by copying the old filename, size and modification time.
    const file = await open(
      path,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    )
    try {
      const original = await file.stat({ bigint: true })
      if (
        !original.isFile() ||
        original.ino === 0n ||
        original.nlink !== 1n ||
        !sameDownloadIdentity(original, expected)
      )
        return { trashed: false }
      const directory = await this.stageDirectory()
      const destination = join(directory, basename(path))
      await this.operations.rename(path, destination)
      claimed = destination
      // A replacement may have won the race immediately before rename. Check the
      // claimed inode against both the scan and the still-open original inode.
      await this.checkDirectory()
      const [moved, held] = await Promise.all([
        lstat(claimed, { bigint: true }),
        file.stat({ bigint: true })
      ])
      if (
        !moved.isFile() ||
        moved.isSymbolicLink() ||
        !stableIdentity(moved, expected) ||
        !sameDownloadIdentity(moved, held)
      )
        throw new Error('Download changed before it was claimed')
      // Rename changes ctime legitimately. All subsequent checks use this fresh
      // identity; neither replacement nor content changes are adopted afterward.
      await this.checkDirectory()
      if (!(await this.allowed(path, claimed))) throw new Error('Download became excluded')
      const current = await lstat(claimed, { bigint: true })
      if (!sameDownloadIdentity(current, moved)) throw new Error('Claimed download changed')
      await this.trash(claimed)
      this.trashed = true
      return { trashed: true }
    } catch {
      if (!claimed) return { trashed: false }
      // Never use rename for restoration: it overwrites existing destinations on
      // POSIX. Creating a hard link is an atomic no-clobber operation on all three
      // platforms. Unsupported filesystems or occupied names keep the claim intact.
      try {
        await this.checkDirectory()
        await this.operations.link(claimed, path)
        await unlink(claimed)
        return { trashed: false }
      } catch {
        return { trashed: false, recoveryPath: claimed }
      }
    } finally {
      await file.close().catch(() => {})
    }
  }

  async finish(): Promise<void> {
    if (this.trashed || !this.directory) return
    // rmdir removes only an empty directory. Never recursively remove any claim,
    // including an unexpected directory or a file retained for manual recovery.
    try {
      await this.checkDirectory()
      await rmdir(this.directory)
    } catch {
      /* Preserve recovery contents. */
    }
  }
}
