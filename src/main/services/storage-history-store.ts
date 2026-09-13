import { createHash } from 'crypto'
import { app } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile, lstat, readdir } from 'fs/promises'
import { join } from 'path'
import { logError } from './logger'
import type {
  StorageScope,
  StorageSnapshot,
  StorageSnapshotSummary
} from '../../shared/storage-history'

interface StorageIndex {
  version: 1
  scopes: StorageScope[]
  snapshots: StorageSnapshotSummary[]
}
const directory = () =>
  join(app.getPath('userData'), app.isPackaged ? 'storage-history' : 'Kudu-Dev/storage-history')
const file = () => join(directory(), 'index.json')
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export const validStorageId = (id: unknown): id is string =>
  typeof id === 'string' && idPattern.test(id)
let writes: Promise<unknown> = Promise.resolve()
const detailFile = (id: string) => {
  if (!validStorageId(id)) throw new Error('Invalid snapshot ID')
  return join(directory(), id + '.json')
}
const empty = (): StorageIndex => ({ version: 1, scopes: [], snapshots: [] })
const optional = (value: unknown, type: 'number' | 'string') =>
  value === null || typeof value === type
let warned = false
async function readIndex(): Promise<StorageIndex> {
  try {
    await lstat(file())
  } catch (error: any) {
    if (error.code === 'ENOENT') return empty()
    throw error
  }
  try {
    return await parseIndex()
  } catch (error) {
    // A corrupt index must not fail every call forever. Move it aside for inspection and start
    // fresh; detail files are left in place and are not touched by the recovery itself.
    const quarantine = file() + '.corrupt-' + Date.now()
    await rename(file(), quarantine)
    if (!warned) {
      warned = true
      logError(`Storage history index was corrupt and moved to ${quarantine}`, error)
    }
    return empty()
  }
}
async function parseIndex(): Promise<StorageIndex> {
  const fileInfo = await lstat(file())
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > 2 * 1024 * 1024)
    throw new Error('Storage history index is too large')
  const value = JSON.parse(await readFile(file(), 'utf8')) as StorageIndex
  if (
    value.version !== 1 ||
    !Array.isArray(value.scopes) ||
    value.scopes.length > 10 ||
    !Array.isArray(value.snapshots) ||
    value.snapshots.length > 900
  )
    throw new Error('Invalid storage history index')
  if (
    value.scopes.some(
      (s) =>
        !validStorageId(s.id) ||
        typeof s.path !== 'string' ||
        typeof s.volumeId !== 'string' ||
        typeof s.relativeRoot !== 'string' ||
        typeof s.name !== 'string' ||
        typeof s.daily !== 'boolean' ||
        !optional(s.growthAlertBytes, 'number') ||
        !optional(s.freeAlertPercent, 'number') ||
        !optional(s.lastAttemptAt, 'string') ||
        !optional(s.lastAlertAt, 'string')
    ) ||
    value.snapshots.some(
      (s) =>
        !validStorageId(s.id) ||
        !validStorageId(s.scopeId) ||
        typeof s.scopeKey !== 'string' ||
        typeof s.volumeId !== 'string' ||
        !optional(s.volumeFree, 'number') ||
        !optional(s.volumeSize, 'number') ||
        typeof s.checksum !== 'string' ||
        !/^[a-f0-9]{64}$/.test(s.checksum) ||
        !['complete', 'partial', 'cancelled', 'unavailable'].includes(s.status) ||
        !Number.isFinite(Date.parse(s.createdAt)) ||
        !Number.isFinite(s.totalBytes) ||
        s.totalBytes < 0 ||
        !Number.isFinite(s.metadataBytes) ||
        s.metadataBytes < 0
    )
  )
    throw new Error('Invalid storage history metadata')
  return value
}
async function writeIndex(index: StorageIndex) {
  await mkdir(directory(), { recursive: true })
  await writeFile(file() + '.tmp', JSON.stringify(index))
  await rename(file() + '.tmp', file())
}
function mutate(action: (index: StorageIndex) => Promise<void>) {
  const pending = writes.then(async () => {
    const index = await readIndex()
    // A prior interrupted index write or failed unlink can leave unreferenced metadata.
    // Only exact UUID filenames in this private data directory are eligible for cleanup.
    try {
      const referenced = new Set(index.snapshots.map((s) => s.id + '.json'))
      for (const item of await readdir(directory(), { withFileTypes: true })) {
        if (
          item.name.endsWith('.json') &&
          validStorageId(item.name.slice(0, -5)) &&
          !referenced.has(item.name)
        )
          await unlink(join(directory(), item.name))
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
    }
    await action(index)
  })
  writes = pending.catch(() => {})
  return pending
}
export async function getStorageIndex() {
  await writes
  const index = await readIndex()
  if (index.snapshots.some((s) => Date.parse(s.createdAt) < Date.now() - 90 * 86400000)) {
    await mutate(async (current) => {
      const expired = current.snapshots
        .filter((s) => Date.parse(s.createdAt) < Date.now() - 90 * 86400000)
        .map((s) => s.id)
      current.snapshots = current.snapshots.filter((s) => !expired.includes(s.id))
      await writeIndex(current)
      await removeDetails(expired)
    })
    return readIndex()
  }
  return index
}
export async function saveStorageScope(scope: StorageScope) {
  await mutate(async (index) => {
    const at = index.scopes.findIndex((s) => s.id === scope.id)
    if (at < 0) {
      if (index.scopes.length >= 10) throw new Error('You can track up to 10 folders')
      index.scopes.push(scope)
    } else index.scopes[at] = scope
    await writeIndex(index)
  })
}
export async function updateStorageScope(id: string, patch: Partial<StorageScope>) {
  await mutate(async (index) => {
    const scope = index.scopes.find((s) => s.id === id)
    if (!scope) throw new Error('Tracked folder not found')
    Object.assign(scope, patch)
    await writeIndex(index)
  })
}
export async function readStorageSnapshot(id: unknown): Promise<StorageSnapshot> {
  if (!validStorageId(id)) throw new Error('Invalid snapshot ID')
  const index = await getStorageIndex()
  const summary = index.snapshots.find((s) => s.id === id)
  if (!summary) throw new Error('Snapshot not found')
  const path = detailFile(id)
  const fileInfo = await lstat(path)
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > 5 * 1024 * 1024)
    throw new Error('Invalid snapshot file')
  const body = await readFile(path, 'utf8')
  if (createHash('sha256').update(body).digest('hex') !== summary.checksum)
    throw new Error('Snapshot integrity check failed')
  const value = JSON.parse(body) as StorageSnapshot
  if (
    value.id !== id ||
    value.version !== 1 ||
    !Array.isArray(value.rows) ||
    value.rows.length > 5000 ||
    value.rows.some(
      (r) =>
        typeof r.path !== 'string' ||
        r.path.length > 32768 ||
        !Number.isFinite(r.bytes) ||
        r.bytes < 0 ||
        !Number.isSafeInteger(r.files) ||
        r.files < 0
    )
  )
    throw new Error('Invalid snapshot')
  return value
}
async function removeDetails(ids: string[]) {
  for (const id of ids)
    try {
      await unlink(detailFile(id))
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
    }
}
export async function saveStorageSnapshot(snapshot: StorageSnapshot) {
  await mutate(async (index) => {
    if (!index.scopes.some((s) => s.id === snapshot.scopeId))
      throw new Error('Tracked folder was removed')
    const body = JSON.stringify(snapshot),
      bytes = Buffer.byteLength(body)
    if (bytes > 5 * 1024 * 1024) throw new Error('Snapshot exceeds the metadata limit')
    await mkdir(directory(), { recursive: true })
    await writeFile(detailFile(snapshot.id) + '.tmp', body)
    await rename(detailFile(snapshot.id) + '.tmp', detailFile(snapshot.id))
    const { rows: _rows, ...summary } = snapshot
    index.snapshots = index.snapshots.filter((s) => s.id !== snapshot.id)
    index.snapshots.unshift({
      ...summary,
      metadataBytes: bytes,
      checksum: createHash('sha256').update(body).digest('hex')
    })
    const removed: string[] = []
    let budget = 0
    index.snapshots = index.snapshots.filter((s, i) => {
      const keep =
        i < 900 &&
        Date.parse(s.createdAt) >= Date.now() - 90 * 86400000 &&
        budget + s.metadataBytes <= 250 * 1024 * 1024
      if (keep) budget += s.metadataBytes
      else removed.push(s.id)
      return keep
    })
    await writeIndex(index)
    await removeDetails(removed)
  })
}
export async function deleteStorageHistory(id: unknown, scope = false) {
  if (!validStorageId(id)) throw new Error('Invalid storage history ID')
  await mutate(async (index) => {
    const removed = index.snapshots
      .filter((s) => (scope ? s.scopeId === id : s.id === id))
      .map((s) => s.id)
    index.snapshots = index.snapshots.filter((s) => !removed.includes(s.id))
    if (scope) index.scopes = index.scopes.filter((s) => s.id !== id)
    await writeIndex(index)
    await removeDetails(removed)
  })
}
