import { randomUUID } from 'crypto'
import { lstat, opendir, realpath } from 'fs/promises'
import type { BigIntStats } from 'fs'
import { join, resolve } from 'path'
import { downloadKind } from '../../shared/downloads-review'
import type { DownloadsScanResult, DownloadsTrashResult } from '../../shared/downloads-review'
import { validateStorageRoot } from './storage-scan'
import { isExcludedResolved } from './file-utils'
import { mountPoints, isMountPoint } from './mount-points'

type Identity = Pick<BigIntStats, 'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs' | 'birthtimeNs'>
const same = (a: Identity, b: Identity) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.birthtimeNs === b.birthtimeNs
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const incomplete = /(^\.|\.(crdownload|part|partial|download|tmp|temp)$)/i

/** Native-only session: the renderer receives IDs, never deletion authority over paths. */
export class DownloadsReview {
  private session: {
    id: string
    root: string
    rootIdentity: Identity
    files: Map<string, { path: string; identity: Identity }>
  } | null = null
  private busy = false
  constructor(
    private readonly downloads: () => string,
    private readonly exclusions: () => Promise<string[]>,
    private readonly trash: (path: string) => Promise<void>,
    private readonly reveal: (path: string) => void
  ) {}

  private async rootUnchanged(root: string, expected: Identity): Promise<boolean> {
    const validated = await validateStorageRoot(root)
    const current = await lstat(validated, { bigint: true })
    // Directory mtime/ctime changes when files are moved; only its stable identity matters.
    return (
      current.dev === expected.dev &&
      current.ino === expected.ino &&
      current.birthtimeNs === expected.birthtimeNs &&
      samePath(await realpath(root), root) &&
      samePath(await realpath(resolve(this.downloads())), root) &&
      !(await isExcludedResolved(root, await this.exclusions()))
    )
  }

  async scan(): Promise<DownloadsScanResult> {
    if (this.busy) throw new Error('Downloads review is busy. Try again shortly.')
    this.busy = true
    this.session = null
    try {
      const configured = resolve(this.downloads())
      // Native Downloads may be redirected. Resolve the OS-configured root once, then
      // require the canonical path and all ancestors to remain ordinary directories.
      const root = await validateStorageRoot(await realpath(configured))
      const rootIdentity = await lstat(root, { bigint: true })
      const exclusions = await this.exclusions()
      const mounts = await mountPoints()
      if (await isExcludedResolved(root, exclusions))
        throw new Error('Your Downloads folder is excluded in Settings.')
      const session = {
        id: randomUUID(),
        root,
        rootIdentity,
        files: new Map<string, { path: string; identity: Identity }>()
      }
      const result: DownloadsScanResult = {
        scanId: session.id,
        directory: root,
        files: [],
        skipped: 0,
        limited: false
      }
      const started = Date.now()
      const directory = await opendir(root)
      let visited = 0
      for await (const entry of directory) {
        if (++visited > 10000 || Date.now() - started > 30000) {
          result.limited = true
          break
        }
        const path = join(root, entry.name)
        try {
          if (
            incomplete.test(entry.name) ||
            !entry.isFile() ||
            entry.isSymbolicLink() ||
            mounts.has(resolve(path)) ||
            (await isExcludedResolved(path, exclusions))
          ) {
            result.skipped++
            continue
          }
          const info = await lstat(path, { bigint: true })
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.dev !== rootIdentity.dev ||
            !samePath(await realpath(path), path)
          ) {
            result.skipped++
            continue
          }
          const id = randomUUID()
          session.files.set(id, { path, identity: info })
          result.files.push({
            id,
            name: entry.name,
            size: Number(info.size),
            modified: Number(info.mtimeMs),
            kind: downloadKind(entry.name)
          })
        } catch {
          result.skipped++
        }
      }
      if (!(await this.rootUnchanged(root, rootIdentity)))
        throw new Error('Downloads changed during the scan. Please scan again.')
      this.session = session
      return result
    } finally {
      this.busy = false
    }
  }

  private async validated(scanId: string, id: string): Promise<string | null> {
    const session = this.session
    if (!session || session.id !== scanId) return null
    const file = session.files.get(id)
    if (!file || !(await this.rootUnchanged(session.root, session.rootIdentity))) return null
    if (
      (await isExcludedResolved(file.path, await this.exclusions())) ||
      (await isMountPoint(file.path))
    )
      return null
    const info = await lstat(file.path, { bigint: true })
    return info.isFile() &&
      !info.isSymbolicLink() &&
      same(info, file.identity) &&
      samePath(await realpath(file.path), file.path)
      ? file.path
      : null
  }

  async trashSelected(scanId: string, ids: string[]): Promise<DownloadsTrashResult> {
    if (this.busy) throw new Error('Downloads review is busy. Try again shortly.')
    if (
      typeof scanId !== 'string' ||
      !Array.isArray(ids) ||
      ids.length > 10000 ||
      ids.some((id) => typeof id !== 'string')
    )
      throw new Error('Invalid selection')
    this.busy = true
    const result: DownloadsTrashResult = { trashedIds: [], skippedIds: [] }
    try {
      for (const id of new Set(ids)) {
        try {
          const path = await this.validated(scanId, id)
          if (!path) {
            result.skippedIds.push(id)
            continue
          }
          await this.trash(path)
          this.session?.files.delete(id)
          result.trashedIds.push(id)
        } catch {
          result.skippedIds.push(id)
        }
      }
      return result
    } finally {
      this.busy = false
    }
  }

  async openLocation(scanId: string, id: string): Promise<void> {
    if (typeof scanId !== 'string' || typeof id !== 'string') throw new Error('Invalid file')
    const path = await this.validated(scanId, id)
    if (!path) throw new Error('This file changed. Scan Downloads again.')
    this.reveal(path)
  }
}
