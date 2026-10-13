import { randomUUID } from 'crypto'
import { lstat, mkdir, opendir, readFile, realpath, rename, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { homedir } from 'os'
import type { BigIntStats } from 'fs'
import type {
  CustomFolder,
  CustomFolderScan,
  CustomFolderTrashResult
} from '../../shared/custom-folders'
import { DownloadsClaimBatch, sameDownloadIdentity } from './downloads-claim'
import type { DownloadIdentity } from './downloads-claim'
import { isExcludedResolved } from './file-utils'
import { mountPoints } from './mount-points'
import { validateStorageRoot } from './storage-scan'

const key = (path: string): string =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const within = (path: string, root: string): boolean =>
  key(path) === key(root) || key(path).startsWith(key(root) + sep)
const sameDirectory = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs

/** Exact local folders only. Broad user/system roots are never custom cleanup targets. */
export function assertCustomFolderPath(path: string, home = homedir()): void {
  if (
    typeof path !== 'string' ||
    path.length > 4096 ||
    !isAbsolute(path) ||
    /[\0*?]/.test(path) ||
    path.startsWith('\\\\') ||
    (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(path))
  )
    throw new Error('Choose an exact local folder path without wildcards.')
  const resolved = resolve(path)
  if (dirname(resolved) === resolved || within(home, resolved))
    throw new Error('Choose a specific cache folder, not a drive or home folder.')
  const userRoots = [
    'Desktop',
    'Documents',
    'Downloads',
    'Pictures',
    'Music',
    'Videos',
    'AppData',
    '.config',
    '.cache',
    '.local',
    'Library'
  ]
  if (userRoots.some((name) => key(resolved) === key(join(home, name))))
    throw new Error('Choose a specific cache folder, not a user folder.')
  const protectedRoots =
    process.platform === 'win32'
      ? [
          process.env.WINDIR || 'C:\\Windows',
          process.env.ProgramFiles || 'C:\\Program Files',
          process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
          process.env.ProgramData || 'C:\\ProgramData',
          join(dirname(home), 'Default'),
          join(dirname(home), 'Public')
        ]
      : process.platform === 'darwin'
        ? [
            '/System',
            '/Library',
            '/Applications',
            '/usr',
            '/bin',
            '/sbin',
            '/etc',
            '/private/etc',
            '/dev',
            '/proc'
          ]
        : ['/usr', '/bin', '/sbin', '/etc', '/boot', '/dev', '/proc', '/sys', '/root']
  if (
    protectedRoots.some((root) => within(resolved, root) || within(root, resolved)) ||
    /(^|[\\/])(\$recycle\.bin|system volume information|Kudu (Downloads|Custom Folder) Recovery-[^\\/]*)($|[\\/])/i.test(
      resolved
    )
  )
    throw new Error('System and recovery folders cannot be custom cleanup targets.')
}

type Session = {
  id: string
  folder: CustomFolder
  directories: Map<string, BigIntStats>
  files: Map<string, { path: string; identity: DownloadIdentity }>
}

/** Saved targets and scan authority stay in the main process; cleanup accepts opaque IDs. */
export class CustomFolders {
  private busy = false
  private session: Session | null = null
  constructor(
    private readonly storePath: string,
    private readonly exclusions: () => Promise<string[]>,
    private readonly trash: (path: string) => Promise<void>
  ) {}

  async list(): Promise<CustomFolder[]> {
    try {
      const data: unknown = JSON.parse(await readFile(this.storePath, 'utf8'))
      if (!Array.isArray(data) || data.length > 100) throw new Error('Invalid custom folders file.')
      return data.map((item) => {
        if (
          !item ||
          typeof item.id !== 'string' ||
          typeof item.name !== 'string' ||
          typeof item.path !== 'string'
        )
          throw new Error('Invalid custom folders file.')
        return { id: item.id, name: item.name, path: item.path }
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async save(folders: CustomFolder[]): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true })
    const temporary = this.storePath + '.tmp'
    await writeFile(temporary, JSON.stringify(folders, null, 2), { mode: 0o600 })
    await rename(temporary, this.storePath)
    this.session = null
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Custom folders are busy. Try again shortly.')
    this.busy = true
    try {
      return await operation()
    } finally {
      this.busy = false
    }
  }

  async add(name: string, path: string): Promise<CustomFolder[]> {
    return this.exclusive(async () => {
      if (typeof name !== 'string' || !name.trim() || name.length > 100)
        throw new Error('Enter a name of up to 100 characters.')
      assertCustomFolderPath(path)
      // Validate before realpath, so a chosen junction cannot silently become a target.
      const root = await realpath(await validateStorageRoot(path))
      assertCustomFolderPath(root)
      const folders = await this.list()
      if (folders.length >= 100) throw new Error('You can save up to 100 custom folders.')
      if (folders.some((folder) => within(root, folder.path) || within(folder.path, root)))
        throw new Error('This folder overlaps an existing custom folder.')
      folders.push({ id: randomUUID(), name: name.trim(), path: root })
      await this.save(folders)
      return folders
    })
  }

  async remove(id: string): Promise<CustomFolder[]> {
    return this.exclusive(async () => {
      if (typeof id !== 'string') throw new Error('Invalid folder.')
      const folders = (await this.list()).filter((folder) => folder.id !== id)
      await this.save(folders)
      return folders
    })
  }

  private async directoryUnchanged(session: Session, path: string): Promise<boolean> {
    assertCustomFolderPath(session.folder.path)
    if (!within(path, session.folder.path)) return false
    await validateStorageRoot(path)
    const exclusions = await this.exclusions()
    const mounts = await mountPoints()
    for (let current = path; ; current = dirname(current)) {
      const expected = session.directories.get(current)
      if (
        !expected ||
        !sameDirectory(await lstat(current, { bigint: true }), expected) ||
        key(await realpath(current)) !== key(current) ||
        (await isExcludedResolved(current, exclusions)) ||
        (current !== session.folder.path && mounts.has(resolve(current)))
      )
        return false
      if (current === session.folder.path) return true
      if (dirname(current) === current) return false
    }
  }

  async scan(id: string): Promise<CustomFolderScan> {
    return this.exclusive(async () => {
      this.session = null
      const folder = (await this.list()).find((folder) => folder.id === id)
      if (!folder) throw new Error('Custom folder no longer exists.')
      assertCustomFolderPath(folder.path)
      await validateStorageRoot(folder.path)
      if (key(await realpath(folder.path)) !== key(folder.path))
        throw new Error('Folder changed. Add it again.')
      const root = await lstat(folder.path, { bigint: true })
      const session: Session = {
        id: randomUUID(),
        folder,
        directories: new Map([[folder.path, root]]),
        files: new Map()
      }
      const result: CustomFolderScan = {
        scanId: session.id,
        folder,
        files: [],
        skipped: 0,
        limited: false
      }
      const exclusions = await this.exclusions()
      if (await isExcludedResolved(folder.path, exclusions))
        throw new Error('This folder is excluded in Settings.')
      const mounts = await mountPoints()
      const queue = [{ path: folder.path, depth: 0 }]
      const started = Date.now()
      let visited = 0
      outer: while (queue.length) {
        const directory = queue.pop()!
        if (Date.now() - started > 30000) {
          result.limited = true
          break
        }
        try {
          if (!(await this.directoryUnchanged(session, directory.path))) {
            result.skipped++
            result.limited = true
            continue
          }
          const handle = await opendir(directory.path)
          for await (const entry of handle) {
            if (++visited > 10000 || Date.now() - started > 30000) {
              result.limited = true
              break outer
            }
            const path = join(directory.path, entry.name)
            try {
              if (
                entry.name.startsWith('Kudu Downloads Recovery-') ||
                entry.name.startsWith('Kudu Custom Folder Recovery-')
              ) {
                result.skipped++
                continue
              }
              const info = await lstat(path, { bigint: true })
              if (
                info.isSymbolicLink() ||
                info.dev !== root.dev ||
                mounts.has(resolve(path)) ||
                key(await realpath(path)) !== key(path) ||
                (await isExcludedResolved(path, exclusions))
              ) {
                result.skipped++
                continue
              }
              if (info.isDirectory()) {
                if (directory.depth >= 20) {
                  result.limited = true
                  result.skipped++
                  continue
                }
                session.directories.set(path, info)
                queue.push({ path, depth: directory.depth + 1 })
              } else if (info.isFile() && info.nlink === 1n && info.ino !== 0n) {
                const fileId = randomUUID()
                session.files.set(fileId, { path, identity: info })
                result.files.push({
                  id: fileId,
                  path: relative(folder.path, path),
                  size: Number(info.size),
                  modified: Number(info.mtimeMs)
                })
              } else result.skipped++
            } catch {
              result.skipped++
            }
          }
          if (!(await this.directoryUnchanged(session, directory.path)))
            throw new Error('Folder changed during scan.')
        } catch {
          result.skipped++
          result.limited = true
        }
      }
      if (!(await this.directoryUnchanged(session, folder.path)))
        throw new Error('Folder changed. Scan again.')
      this.session = session
      return result
    })
  }

  async trashSelected(scanId: string, ids: string[]): Promise<CustomFolderTrashResult> {
    return this.exclusive(async () => {
      if (
        typeof scanId !== 'string' ||
        !Array.isArray(ids) ||
        ids.length > 10000 ||
        ids.some((id) => typeof id !== 'string')
      )
        throw new Error('Invalid selection.')
      const session = this.session
      if (!session || session.id !== scanId) throw new Error('This preview expired. Scan again.')
      const result: CustomFolderTrashResult = { trashedIds: [], skippedIds: [] }
      const claims = new Map<string, DownloadsClaimBatch>()
      try {
        for (const id of new Set(ids)) {
          try {
            const file = session.files.get(id)
            if (
              !file ||
              !(await this.directoryUnchanged(session, dirname(file.path))) ||
              (await isExcludedResolved(file.path, await this.exclusions())) ||
              (await mountPoints()).has(resolve(file.path))
            ) {
              result.skippedIds.push(id)
              continue
            }
            const info = await lstat(file.path, { bigint: true })
            if (
              !info.isFile() ||
              info.isSymbolicLink() ||
              info.nlink !== 1n ||
              !sameDownloadIdentity(info, file.identity)
            ) {
              result.skippedIds.push(id)
              continue
            }
            const parent = dirname(file.path)
            let claim = claims.get(parent)
            if (!claim) {
              claim = new DownloadsClaimBatch(
                parent,
                () => this.directoryUnchanged(session, parent),
                this.trash,
                async (original, claimed) => {
                  const exclusions = await this.exclusions()
                  return (
                    !(await isExcludedResolved(original, exclusions)) &&
                    !(await isExcludedResolved(claimed, exclusions)) &&
                    !(await mountPoints()).has(resolve(claimed))
                  )
                },
                undefined,
                'Kudu Custom Folder Recovery-'
              )
              claims.set(parent, claim)
            }
            const moved = await claim.move(file.path, file.identity)
            if (moved.trashed) {
              session.files.delete(id)
              result.trashedIds.push(id)
            } else {
              result.skippedIds.push(id)
              if (moved.recoveryPath) (result.recoveryPaths ??= []).push(moved.recoveryPath)
            }
          } catch {
            result.skippedIds.push(id)
          }
        }
        return result
      } finally {
        for (const claim of claims.values()) await claim.finish()
      }
    })
  }
}
