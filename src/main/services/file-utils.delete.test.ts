import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ScanItem } from '../../shared/types'

const state = vi.hoisted(() => ({
  rootPath: '',
  rootFailuresRemaining: 0,
  lockedPath: '',
  permissionPaths: new Set<string>(),
  statFailurePath: '',
  consumed: [] as string[],
  trackConcurrency: false,
  activeDeletes: 0,
  maxActiveDeletes: 0,
  items: [] as ScanItem[],
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]) === state.statFailurePath) throw Object.assign(new Error('access denied'), { code: 'EACCES' })
      return actual.lstat(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const path = String(args[0])
      const options = args[1] as { recursive?: boolean } | undefined
      if (path === state.rootPath && options?.recursive && state.rootFailuresRemaining > 0) {
        state.rootFailuresRemaining--
        throw Object.assign(new Error('sharing violation'), { code: 'EPERM' })
      }
      if (path === state.lockedPath) {
        throw Object.assign(new Error('sharing violation'), { code: 'EPERM' })
      }
      if (!state.trackConcurrency) return actual.rm(...args)
      state.activeDeletes++
      state.maxActiveDeletes = Math.max(state.maxActiveDeletes, state.activeDeletes)
      try {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return await actual.rm(...args)
      } finally {
        state.activeDeletes--
      }
    },
  }
})

vi.mock('./settings-store', () => ({
  getSettings: () => ({
    cleaner: { secureDelete: false, skipRecentMinutes: 60, keepDeletionLog: false },
    exclusions: [],
  }),
}))

vi.mock('./scan-cache', () => ({
  getCachedItems: () => state.items,
  removeCachedItems: (ids: string[]) => { state.consumed.push(...ids) },
}))

vi.mock('./deletion-log-store', () => ({ recordDeletions: () => {} }))

vi.mock('./delete-failure-probe', () => ({
  probeWindowsDeleteFailures: async (paths: string[]) => new Map(
    paths
      .filter((path) => state.permissionPaths.has(path))
      .map((path) => [path.toLowerCase(), 'permission-denied'])
  ),
}))

import { cleanItems, safeDelete } from './file-utils'

let testDir: string

function createTree(): { root: string; removable: string; locked: string } {
  const root = join(testDir, 'abandoned-app')
  const removable = join(root, 'cache.tmp')
  const locked = join(root, 'resources', 'app.asar')
  mkdirSync(join(root, 'resources'), { recursive: true })
  writeFileSync(removable, 'cache')
  writeFileSync(locked, 'archive')
  return { root, removable, locked }
}

describe('granular directory deletion fallback', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'kudu-delete-'))
    state.rootPath = ''
    state.rootFailuresRemaining = 0
    state.lockedPath = ''
    state.permissionPaths.clear()
    state.statFailurePath = ''
    state.consumed = []
    state.trackConcurrency = false
    state.activeDeletes = 0
    state.maxActiveDeletes = 0
    state.items = []
  })

  afterEach(() => {
    if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  it('removes the whole tree when only the coarse recursive delete fails', async () => {
    const { root } = createTree()
    state.rootPath = root
    // attemptDelete retries once after clearing a Windows read-only attribute.
    state.rootFailuresRemaining = process.platform === 'win32' ? 2 : 1

    const result = await safeDelete(root)

    expect(result).toEqual({ path: root, success: true })
    expect(existsSync(root)).toBe(false)
  })

  it('reports lookup permission failures without consuming the retryable scan item', async () => {
    const { removable } = createTree()
    state.items = [{ id: 'retry', path: removable, size: 5, category: 'system', subcategory: 'Temp', lastModified: 0, selected: true }]
    state.statFailurePath = removable
    const progress = vi.fn()
    const result = await cleanItems(['retry'], progress)
    expect(result).toMatchObject({ totalCleaned: 0, filesSkipped: 1, needsElevation: true, errors: [{ path: removable, reason: 'permission-denied' }] })
    expect(state.consumed).toEqual([])
    expect(existsSync(removable)).toBe(true)
    expect(progress).toHaveBeenLastCalledWith(1, 1, removable, 0)
    state.statFailurePath = ''
    expect((await cleanItems(['retry'])).totalCleaned).toBe(5)
    expect(state.consumed).toEqual(['retry'])
  })

  it('deletes removable siblings and reports only the exact locked descendant', async () => {
    const { root, removable, locked } = createTree()
    state.rootPath = root
    state.rootFailuresRemaining = process.platform === 'win32' ? 2 : 1
    state.lockedPath = locked
    state.items = [{
      id: 'abandoned-app',
      path: root,
      size: 12,
      category: 'system',
      subcategory: 'User Temp Files',
      lastModified: 0,
      selected: true,
    }]

    const result = await cleanItems(['abandoned-app'])

    expect(existsSync(removable)).toBe(false)
    expect(existsSync(locked)).toBe(true)
    expect(result.filesDeleted).toBe(0)
    expect(result.filesSkipped).toBe(1)
    expect(result.totalCleaned).toBe(5)
    const expectedReason = process.platform === 'win32' ? 'in-use' : 'permission-denied'
    expect(result.errors).toEqual([{ path: locked, reason: expectedReason }])
    expect(result.needsElevation).toBe(process.platform !== 'win32')
  })

  it('reports Windows EPERM below a non-writable parent as needing elevation', async () => {
    const { root, locked } = createTree()
    state.rootPath = root
    state.rootFailuresRemaining = process.platform === 'win32' ? 2 : 1
    state.lockedPath = locked
    state.permissionPaths.add(locked)
    state.items = [{
      id: 'abandoned-app',
      path: root,
      size: 12,
      category: 'system',
      subcategory: 'Protected Cache',
      lastModified: 0,
      selected: true,
    }]

    const result = await cleanItems(['abandoned-app'])

    expect(result.errors).toEqual([{ path: locked, reason: 'permission-denied' }])
    expect(result.needsElevation).toBe(true)
  })

  it('uses a bounded worker pool for independent cache entries', async () => {
    state.trackConcurrency = true
    state.items = Array.from({ length: 16 }, (_, index) => {
      const path = join(testDir, `cache-${index}.tmp`)
      writeFileSync(path, 'cache')
      return {
        id: `cache-${index}`,
        path,
        size: 5,
        category: 'browser',
        subcategory: 'Browser Cache',
        lastModified: 0,
        selected: true,
      }
    })

    const result = await cleanItems(state.items.map((item) => item.id))

    expect(result.filesDeleted).toBe(16)
    expect(state.maxActiveDeletes).toBe(8)
  })

  it('unlinks directory junctions without traversing their targets', async (ctx) => {
    const { root } = createTree()
    const external = join(testDir, 'keep-external')
    const externalFile = join(external, 'keep.dat')
    mkdirSync(external)
    writeFileSync(externalFile, 'keep')
    try {
      symlinkSync(external, join(root, 'external-link'), 'junction')
    } catch (err: any) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(err.code)) {
        ctx.skip('Windows does not permit creating the test junction')
        return
      }
      throw err
    }
    state.rootPath = root
    state.rootFailuresRemaining = process.platform === 'win32' ? 2 : 1

    const result = await safeDelete(root)

    expect(result.success).toBe(true)
    expect(existsSync(root)).toBe(false)
    expect(existsSync(externalFile)).toBe(true)
  })
})
