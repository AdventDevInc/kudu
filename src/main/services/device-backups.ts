import { constants, type BigIntStats } from 'fs'
import { lstat, mkdtemp, open, readdir, realpath, rename, rmdir } from 'fs/promises'
import { createHash, randomUUID } from 'crypto'
import { join, relative } from 'path'
import type {
  DeviceBackupItem,
  DeviceBackupRemoval,
  DeviceBackupScan
} from '../../shared/icloud-cleanup'
import { sameDownloadIdentity } from './downloads-claim'

type CapturedBackup = {
  path: string
  identity: BigIntStats
  fingerprint: string
  item: DeviceBackupItem
}
type BackupSession = {
  id: string
  created: number
  root: BigIntStats
  items: Map<string, CapturedBackup>
}
const sameDirectory = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs

/** Scan authority and paths stay in the main process. Only complete, stable local backups are eligible. */
export class DeviceBackups {
  private session: BackupSession | null = null
  private busy = false
  constructor(
    private readonly root: string,
    private readonly trash: (path: string) => Promise<void>,
    private readonly readPlistValue: (path: string, key: string) => Promise<string>,
    private readonly now = () => Date.now()
  ) {}

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('A device backup operation is already running.')
    this.busy = true
    try {
      return await action()
    } finally {
      this.busy = false
    }
  }

  private async rootUnchanged(expected?: BigIntStats): Promise<BigIntStats> {
    const info = await lstat(this.root, { bigint: true })
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(this.root)) !== this.root ||
      (expected && !sameDirectory(info, expected))
    ) {
      throw new Error('The backup location changed or uses a symbolic link. Manage it in Finder.')
    }
    return info
  }

  private async inspectTree(path: string, device: bigint) {
    const digest = createHash('sha256')
    const directories = [path]
    let bytes = 0
    let files = 0
    let count = 0
    let latest = 0
    while (directories.length) {
      const directory = directories.pop()!
      if ((await realpath(directory)) !== directory) throw new Error('A backup directory changed.')
      const directoryInfo = await lstat(directory, { bigint: true })
      if (!directoryInfo.isDirectory() || directoryInfo.dev !== device)
        throw new Error('Unsupported backup directory.')
      // Rename legitimately changes the root ctime. Descendants retain their identities.
      digest.update(
        JSON.stringify([
          relative(path, directory),
          String(directoryInfo.dev),
          String(directoryInfo.ino),
          String(directoryInfo.mtimeNs)
        ])
      )
      const names = (await readdir(directory)).sort()
      for (const name of names) {
        if (++count > 300_000)
          throw new Error('Backup scan limit reached. Manage this backup in Finder.')
        const child = join(directory, name)
        const info = await lstat(child, { bigint: true })
        if (info.dev !== device || info.isSymbolicLink())
          throw new Error('Linked files or mounted volumes require manual review.')
        if (info.isDirectory()) directories.push(child)
        else if (info.isFile() && info.nlink === 1n) {
          digest.update(
            JSON.stringify([
              relative(path, child),
              String(info.ino),
              String(info.size),
              String(info.mtimeNs),
              String(info.ctimeNs)
            ])
          )
          bytes += Number(info.blocks) * 512
          files++
          latest = Math.max(latest, Number(info.mtimeMs))
        } else throw new Error('Unsupported backup file.')
      }
    }
    return { fingerprint: digest.digest('hex'), bytes, files, latest }
  }

  async scan(): Promise<DeviceBackupScan> {
    return this.exclusive(async () => {
      this.session = null
      const id = randomUUID()
      let root: BigIntStats
      try {
        root = await this.rootUnchanged()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { scanId: id, root: this.root, items: [], missing: true }
        }
        throw error
      }
      const session: BackupSession = { id, created: this.now(), root, items: new Map() }
      const items: DeviceBackupItem[] = []
      for (const folder of (await readdir(this.root)).sort()) {
        if (!/^[a-f0-9]{8,40}(?:-[a-f0-9]{8,24})?(?:-\d{8}-\d{6})?$/i.test(folder)) continue
        const item: DeviceBackupItem = {
          id: randomUUID(),
          folder,
          deviceName: folder,
          modified: 0,
          bytes: 0,
          files: 0,
          eligible: false
        }
        items.push(item)
        try {
          const path = join(this.root, folder)
          const identity = await lstat(path, { bigint: true })
          if (!identity.isDirectory() || identity.isSymbolicLink() || identity.dev !== root.dev)
            throw new Error('Unsupported backup location.')
          for (const file of ['Info.plist', 'Manifest.plist', 'Status.plist']) {
            const info = await lstat(join(path, file))
            if (!info.isFile() || info.isSymbolicLink())
              throw new Error('Backup metadata is missing or linked.')
          }
          item.deviceName =
            (await this.readPlistValue(join(path, 'Info.plist'), 'Device Name')).trim() || folder
          item.modified = Number(identity.mtimeMs)
          const state = await this.readPlistValue(join(path, 'Status.plist'), 'SnapshotState')
          if (state.trim() !== 'finished')
            throw new Error('Backup is incomplete or may be in progress.')
          const tree = await this.inspectTree(path, root.dev)
          item.bytes = tree.bytes
          item.files = tree.files
          if (this.now() - tree.latest < 60_000)
            throw new Error(
              'Backup was recently modified. Disconnect the device and scan again after one minute.'
            )
          const after = await lstat(path, { bigint: true })
          if (!sameDownloadIdentity(identity, after))
            throw new Error('Backup changed during analysis.')
          item.eligible = true
          session.items.set(item.id, { path, identity, fingerprint: tree.fingerprint, item })
        } catch (error) {
          item.reason = String(error)
        }
      }
      await this.rootUnchanged(root)
      this.session = session
      return { scanId: id, root: this.root, items, missing: false }
    })
  }

  async remove(
    scanId: unknown,
    ids: unknown,
    confirmation: unknown,
    devicesDisconnected: unknown
  ): Promise<DeviceBackupRemoval> {
    return this.exclusive(async () => {
      const session = this.session
      if (!session || scanId !== session.id || this.now() - session.created > 10 * 60_000) {
        throw new Error('Analyze the device backups again before removing anything.')
      }
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > 100 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => typeof id !== 'string' || !session.items.has(id)) ||
        !['DELETE', 'SUPPRIMER'].includes(String(confirmation)) ||
        devicesDisconnected !== true
      ) {
        throw new Error('Select valid backups and confirm that the devices are disconnected.')
      }
      const result: DeviceBackupRemoval = { removedIds: [], skipped: [], recoveryPaths: [] }
      await this.rootUnchanged(session.root)
      for (const id of ids as string[]) {
        const backup = session.items.get(id)!
        let held: Awaited<ReturnType<typeof open>> | undefined
        let claim: string | undefined
        let staging: string | undefined
        try {
          held = await open(
            backup.path,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
          )
          const identity = await held.stat({ bigint: true })
          if (!sameDownloadIdentity(identity, backup.identity))
            throw new Error('Backup changed since analysis.')
          const state = await this.readPlistValue(
            join(backup.path, 'Status.plist'),
            'SnapshotState'
          )
          if (state.trim() !== 'finished') throw new Error('Backup may be in progress.')
          const tree = await this.inspectTree(backup.path, session.root.dev)
          if (tree.fingerprint !== backup.fingerprint || this.now() - tree.latest < 60_000)
            throw new Error('Backup contents changed. Analyze again.')
          await this.rootUnchanged(session.root)
          staging = await mkdtemp(join(this.root, '.kudu-backup-claim-'))
          claim = join(staging, backup.item.folder)
          await rename(backup.path, claim)
          const moved = await lstat(claim, { bigint: true })
          if (
            !sameDirectory(moved, identity) ||
            !sameDirectory(await held.stat({ bigint: true }), moved)
          ) {
            throw new Error('The backup was replaced while being selected.')
          }
          const claimedTree = await this.inspectTree(claim, session.root.dev)
          if (claimedTree.fingerprint !== backup.fingerprint)
            throw new Error('Backup changed before removal.')
          await this.rootUnchanged(session.root)
          await this.trash(claim)
          result.removedIds.push(id)
          session.items.delete(id)
          // Keep the private directory so the OS Trash has a valid restore destination.
          claim = undefined
        } catch (error) {
          result.skipped.push({ id, message: String(error) })
          if (claim) {
            result.recoveryPaths.push(claim)
            session.items.delete(id)
          } else if (staging) await rmdir(staging).catch(() => {})
        } finally {
          await held?.close().catch(() => {})
        }
      }
      return result
    })
  }
}
