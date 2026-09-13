import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, access } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import type { StorageScope, StorageSnapshot } from '../../shared/storage-history'
const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.directory, isPackaged: true } }))
import {
  saveStorageScope,
  saveStorageSnapshot,
  readStorageSnapshot,
  getStorageIndex,
  deleteStorageHistory
} from './storage-history-store'
let scope: StorageScope
const snapshot = (): StorageSnapshot => ({
  version: 1,
  id: randomUUID(),
  scopeId: scope.id,
  scopeKey: 'policy',
  createdAt: new Date().toISOString(),
  durationMs: 10,
  status: 'complete',
  reason: null,
  volumeId: scope.volumeId,
  totalBytes: 123,
  files: 1,
  skipped: 0,
  errors: 0,
  volumeSize: 1000,
  volumeFree: 500,
  rows: [{ path: '', bytes: 123, files: 1 }]
})
beforeEach(async () => {
  state.directory = await mkdtemp(join(tmpdir(), 'kudu-storage-store-test-'))
  scope = {
    id: randomUUID(),
    name: 'Test',
    path: state.directory,
    volumeId: 'volume',
    relativeRoot: 'test',
    daily: false,
    growthAlertBytes: null,
    freeAlertPercent: null,
    lastAttemptAt: null,
    lastAlertAt: null
  }
  await saveStorageScope(scope)
})
afterEach(async () => {
  await rm(state.directory, { recursive: true, force: true })
})
it('preserves concurrent captures and reads details only by known IDs', async () => {
  const entries = [snapshot(), snapshot()]
  await Promise.all(entries.map(saveStorageSnapshot))
  expect((await getStorageIndex()).snapshots).toHaveLength(2)
  expect(await readStorageSnapshot(entries[0].id)).toEqual(entries[0])
  await expect(readStorageSnapshot('../outside')).rejects.toThrow('Invalid snapshot ID')
  await expect(readStorageSnapshot(randomUUID())).rejects.toThrow('not found')
})
it('prunes old metadata and removes only tracked snapshot files', async () => {
  const old = { ...snapshot(), createdAt: new Date(Date.now() - 91 * 86400000).toISOString() }
  await saveStorageSnapshot(old)
  expect((await getStorageIndex()).snapshots).toHaveLength(0)
  await expect(access(join(state.directory, 'storage-history', old.id + '.json'))).rejects.toThrow()
  const fresh = snapshot()
  await saveStorageSnapshot(fresh)
  await deleteStorageHistory(scope.id, true)
  expect((await getStorageIndex()).scopes).toHaveLength(0)
  await expect(
    access(join(state.directory, 'storage-history', fresh.id + '.json'))
  ).rejects.toThrow()
  await expect(access(state.directory)).resolves.toBeUndefined()
})
it('fails closed on a corrupt index without deleting valid metadata', async () => {
  const saved = snapshot()
  await saveStorageSnapshot(saved)
  const index = join(state.directory, 'storage-history/index.json')
  await writeFile(index, '{broken')
  await expect(saveStorageSnapshot(snapshot())).rejects.toThrow()
  expect(await readFile(index, 'utf8')).toBe('{broken')
  expect(
    JSON.parse(await readFile(join(state.directory, 'storage-history', saved.id + '.json'), 'utf8'))
      .id
  ).toBe(saved.id)
})
it('recovers an orphan after an interrupted index write without touching unrelated files', async () => {
  const orphan = randomUUID() + '.json'
  await writeFile(join(state.directory, 'storage-history', orphan), '{}')
  await writeFile(join(state.directory, 'storage-history', 'notes.json'), 'private')
  await saveStorageSnapshot(snapshot())
  await expect(access(join(state.directory, 'storage-history', orphan))).rejects.toThrow()
  expect(await readFile(join(state.directory, 'storage-history', 'notes.json'), 'utf8')).toBe(
    'private'
  )
})

it('rejects corrupt snapshot details before comparing or exporting them', async () => {
  const saved = snapshot()
  await saveStorageSnapshot(saved)
  await writeFile(
    join(state.directory, 'storage-history', saved.id + '.json'),
    JSON.stringify({ ...saved, totalBytes: 9999 })
  )
  await expect(readStorageSnapshot(saved.id)).rejects.toThrow('integrity check failed')
})
