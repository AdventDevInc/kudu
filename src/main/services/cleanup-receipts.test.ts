import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ScanItem } from '../../shared/types'

const state = vi.hoisted(() => ({ root: '', logPaths: false }))
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => state.root } }))
vi.mock('./settings-store', () => ({
  getSettings: () => ({ cleaner: { keepDeletionLog: state.logPaths } })
}))
import {
  createReceipt,
  getCleanupReceipt,
  getCleanupReceipts,
  receiptRetryIds,
  clearCleanupReceipts,
  recordNativeCleanup
} from './cleanup-receipts'
import { cacheItems, clearCache, removeCachedItems } from './scan-cache'

const item: ScanItem = {
  id: '11111111-1111-4111-8111-111111111111',
  path: '/private/alice/cache',
  category: 'app',
  subcategory: 'App cache',
  size: 50,
  lastModified: 0,
  selected: true
}
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'kudu-receipts-'))
  state.logPaths = false
  clearCache()
})
afterEach(async () => {
  await rm(state.root, { recursive: true, force: true })
  vi.useRealTimers()
})
describe('receipt persistence and retry authorization', () => {
  it('stores paginatable detail separately and never writes paths or raw errors when logging is off', async () => {
    cacheItems([item])
    const receipt = createReceipt('local', undefined, [item])
    receipt.add(item, 'failed', 'Unable to delete /private/alice/cache')
    await receipt.finish()
    const summaries = await getCleanupReceipts()
    expect(summaries[0].details).toEqual([])
    const saved = await getCleanupReceipt(receipt.id)
    expect(saved.details[0].reason).toBe('other-error')
    expect(JSON.stringify(saved)).not.toContain('/private/')
    expect(saved.found).toBe(1)
    expect(receiptRetryIds(receipt.id)).toEqual([item.id])
    removeCachedItems([item.id])
    expect(receiptRetryIds(receipt.id)).toEqual([])
    await expect(getCleanupReceipt('../secrets')).rejects.toThrow('Invalid receipt ID')
  })
  it('expires retry authorization without removing readable receipts', async () => {
    cacheItems([item])
    const receipt = createReceipt('local', undefined, [item])
    receipt.add(item, 'failed', 'permission-denied')
    await receipt.finish()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 31 * 60_000)
    expect(receiptRetryIds(receipt.id)).toEqual([])
    expect((await getCleanupReceipt(receipt.id)).failed).toBe(1)
  })
  it('serializes concurrent writes and clears both summaries and detail files', async () => {
    const a = createReceipt('local'),
      b = createReceipt('cli')
    a.add(item, 'deleted', '', true, 50)
    b.add({ ...item, id: 'second' }, 'skipped', 'excluded')
    await Promise.all([a.finish(), b.finish()])
    expect(await getCleanupReceipts()).toHaveLength(2)
    await clearCleanupReceipts()
    expect(await getCleanupReceipts()).toEqual([])
    await expect(getCleanupReceipt(a.id)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('quarantines a corrupt index and keeps recording new receipts', async () => {
    const initial = createReceipt('local')
    initial.add(item, 'deleted')
    await initial.finish()
    const dir = join(state.root, 'cleanup-receipts')
    await writeFile(join(dir, 'receipts.json'), '{broken')
    const next = createReceipt('local')
    next.add(item, 'deleted')
    await expect(next.finish()).resolves.toBeDefined()
    expect((await getCleanupReceipts()).map((r) => r.id)).toEqual([next.id])
    const quarantined = (await readdir(dir)).filter((f) => /^receipts\.json\.corrupt-\d+$/.test(f))
    expect(quarantined).toHaveLength(1)
    expect(await readFile(join(dir, quarantined[0]), 'utf8')).toBe('{broken')
    expect((await getCleanupReceipt(initial.id)).id).toBe(initial.id)
  })
  it('clears a corrupt index instead of failing forever', async () => {
    const dir = join(state.root, 'cleanup-receipts')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'receipts.json'), '{broken')
    await expect(getCleanupReceipts()).rejects.toThrow()
    await expect(clearCleanupReceipts()).resolves.toBeUndefined()
    expect(await getCleanupReceipts()).toEqual([])
    expect((await readdir(dir)).some((f) => f.startsWith('receipts.json.corrupt-'))).toBe(true)
  })
  it('records native operations with an unknown selected size', async () => {
    const result = await recordNativeCleanup('Recycle Bin', async () => ({
      totalCleaned: 10,
      filesDeleted: 1,
      filesSkipped: 0,
      errors: [],
      needsElevation: false
    }))
    expect(result.receiptSaved).toBe(true)
    const saved = await getCleanupReceipt(result.receiptId!)
    expect(saved.details[0]).toMatchObject({ outcome: 'deleted', selectedBytes: null })
  })
})
