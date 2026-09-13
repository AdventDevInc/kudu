import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ScanItem } from '../../shared/types'

const state = vi.hoisted(() => ({
  root: '',
  logPaths: false,
  lockReleases: [] as string[],
  unlinkGate: null as Promise<void> | null
}))
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => state.root } }))
// Record the owner token of every lock the service releases so tests can prove a writer only
// ever deletes the lock it acquired itself.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      if (state.unlinkGate && String(path).endsWith('.json')) await state.unlinkGate
      if (String(path).endsWith('receipts.lock'))
        state.lockReleases.push(await actual.readFile(path, 'utf8').catch(() => '<missing>'))
      return actual.unlink(path)
    }
  }
})
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
  state.lockReleases = []
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
  it('clears a corrupt index and orphaned detail files instead of failing forever', async () => {
    const dir = join(state.root, 'cleanup-receipts')
    await mkdir(dir, { recursive: true })
    const orphan = createReceipt('local')
    orphan.add(item, 'deleted', '', true, 50)
    await orphan.finish()
    await writeFile(join(dir, 'receipts.json'), '{broken')
    await writeFile(join(dir, 'receipts.json.corrupt-1'), '{older')
    await writeFile(join(dir, orphan.id + '.json.tmp'), '{partial')
    await writeFile(join(dir, 'unrelated.txt'), 'keep')
    await expect(getCleanupReceipts()).rejects.toThrow()
    await expect(clearCleanupReceipts()).resolves.toBeUndefined()
    expect(await getCleanupReceipts()).toEqual([])
    await expect(getCleanupReceipt(orphan.id)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(dir)).sort()).toEqual(['receipts.json', 'unrelated.txt'])
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
  it('keeps the sanitized native reason when nothing was removed and records the origin', async () => {
    const locked = await recordNativeCleanup(
      'Database optimization',
      async () => ({
        totalCleaned: 0,
        filesDeleted: 0,
        filesSkipped: 1,
        errors: [{ path: '/private/alice/app.db', reason: 'in-use' }],
        needsElevation: false
      }),
      'cli'
    )
    expect(locked.errors[0].reason).toBe('in-use')
    const lockedReceipt = await getCleanupReceipt(locked.receiptId!)
    expect(lockedReceipt.origin).toBe('cli')
    expect(lockedReceipt.details[0]).toMatchObject({
      outcome: 'failed',
      reason: 'in-use-or-protected'
    })
    expect(JSON.stringify(lockedReceipt)).not.toContain('/private/')

    const unknown = await recordNativeCleanup(
      'Database optimization',
      async () => ({
        totalCleaned: 0,
        filesDeleted: 0,
        filesSkipped: 1,
        errors: [{ path: '/private/alice/app.db', reason: 'disk I/O error at /private/alice' }],
        needsElevation: false
      }),
      'cloud'
    )
    const unknownReceipt = await getCleanupReceipt(unknown.receiptId!)
    expect(unknownReceipt.origin).toBe('cloud')
    expect(unknownReceipt.details[0].reason).toBe('native-cleanup-failed')
    expect(JSON.stringify(unknownReceipt)).not.toContain('/private/')

    const partial = await recordNativeCleanup('Database optimization', async () => ({
      totalCleaned: 5,
      filesDeleted: 1,
      filesSkipped: 1,
      errors: [{ path: '/private/alice/app.db', reason: 'in-use' }],
      needsElevation: false
    }))
    const partialReceipt = await getCleanupReceipt(partial.receiptId!)
    expect(partialReceipt.origin).toBe('local')
    expect(partialReceipt.details[0]).toMatchObject({
      outcome: 'failed',
      reason: 'partial-removal',
      removedBytes: 5
    })
  })
  it('lands concurrent receipts from independent writers in the index using unique temp files', async () => {
    const dir = join(state.root, 'cleanup-receipts')
    const a = createReceipt('local'),
      b = createReceipt('cli')
    a.add(item, 'deleted', '', true, 50)
    b.add({ ...item, id: 'second' }, 'deleted', '', true, 25)
    // Model a second process by defeating the in-process write queue: start both writes in the
    // same tick, so only the cross-process lock can serialize the index update.
    await Promise.all([a.finish(), b.finish()])
    const ids = (await getCleanupReceipts()).map((r) => r.id)
    expect(ids).toHaveLength(2)
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]))
    const files = await readdir(dir)
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(files).not.toContain('receipts.lock')
  })
  it('waits for a live lock held by another process and reclaims a stale one', async () => {
    const dir = join(state.root, 'cleanup-receipts')
    await mkdir(dir, { recursive: true })
    const lock = join(dir, 'receipts.lock')
    await writeFile(lock, '')
    const receipt = createReceipt('local')
    receipt.add(item, 'deleted', '', true, 50)
    const pending = receipt.finish()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await readdir(dir)).not.toContain('receipts.json')
    await rm(lock)
    await pending
    expect((await getCleanupReceipts()).map((r) => r.id)).toEqual([receipt.id])

    await writeFile(lock, 'crashed-owner')
    const stale = new Date(Date.now() - 60_000)
    await utimes(lock, stale, stale)
    const next = createReceipt('local')
    next.add(item, 'deleted', '', true, 50)
    await next.finish()
    expect(await getCleanupReceipts()).toHaveLength(2)
    expect(await readdir(dir)).not.toContain('receipts.lock')
    // The stale lock is moved aside, not unlinked in place, and each writer released only its own.
    expect(state.lockReleases).not.toContain('crashed-owner')
    expect(state.lockReleases).toHaveLength(2)
    expect(new Set(state.lockReleases).size).toBe(2)
  })
  it('keeps a live lock fresh while a slow task holds it so no other process reclaims it', async () => {
    const dir = join(state.root, 'cleanup-receipts')
    const receipt = createReceipt('local')
    receipt.add(item, 'deleted', '', true, 50)
    await receipt.finish()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      let release!: () => void
      state.unlinkGate = new Promise<void>((resolve) => (release = resolve))
      const clearing = clearCleanupReceipts()
      await new Promise((resolve) => setTimeout(resolve, 100))
      const lock = join(dir, 'receipts.lock')
      const old = new Date(Date.now() - 60_000)
      await utimes(lock, old, old)
      await vi.advanceTimersByTimeAsync(10_000)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(Date.now() - (await stat(lock)).mtimeMs).toBeLessThan(5_000)
      release()
      state.unlinkGate = null
      await clearing
    } finally {
      state.unlinkGate = null
      vi.useRealTimers()
    }
    expect(await readdir(dir)).not.toContain('receipts.lock')
  })
  it('lets only one of two concurrent reclaimers take a stale lock and keeps the other from deleting it', async () => {
    const dir = join(state.root, 'cleanup-receipts')
    await mkdir(dir, { recursive: true })
    const lock = join(dir, 'receipts.lock')
    await writeFile(lock, 'crashed-owner')
    const stale = new Date(Date.now() - 60_000)
    await utimes(lock, stale, stale)
    const a = createReceipt('local'),
      b = createReceipt('cli')
    a.add(item, 'deleted', '', true, 50)
    b.add({ ...item, id: 'second' }, 'deleted', '', true, 25)
    // Both writers observe the same stale lock in the same tick, as two processes would.
    await Promise.all([a.finish(), b.finish()])
    const ids = (await getCleanupReceipts()).map((r) => r.id)
    expect(ids).toHaveLength(2)
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]))
    // Each writer entered the critical section under its own token and released exactly that
    // lock; the crashed owner's file was renamed away rather than unlinked from under a live owner.
    expect(state.lockReleases).toHaveLength(2)
    expect(state.lockReleases).not.toContain('crashed-owner')
    expect(state.lockReleases).not.toContain('<missing>')
    expect(new Set(state.lockReleases).size).toBe(2)
    for (const token of state.lockReleases) expect(token).toMatch(/^[a-f0-9-]{36}$/)
    const files = await readdir(dir)
    expect(files).not.toContain('receipts.lock')
    expect(files.filter((f) => f.endsWith('.stale'))).toEqual([])
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
  it('clears temp files and stale-lock leftovers left behind by an interrupted write', async () => {
    const dir = join(state.root, 'cleanup-receipts')
    await mkdir(dir, { recursive: true })
    const uuid = '22222222-2222-4222-8222-222222222222'
    await writeFile(join(dir, `receipts.json.${uuid}.tmp`), '[]')
    await writeFile(join(dir, `${item.id}.json.${uuid}.tmp`), '{}')
    await writeFile(join(dir, `receipts.lock.${uuid}.stale`), 'crashed-owner')
    await clearCleanupReceipts()
    expect(await readdir(dir)).toEqual(['receipts.json'])
  })
})
