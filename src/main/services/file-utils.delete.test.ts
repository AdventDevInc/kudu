import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ScanItem } from '../../shared/types'

const state = vi.hoisted(() => ({
  rootPath: '',
  rootFailuresRemaining: 0,
  lockedPath: '',
  items: [] as ScanItem[],
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
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
      return actual.rm(...args)
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
  removeCachedItems: () => {},
}))

vi.mock('./deletion-log-store', () => ({ recordDeletions: () => {} }))

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
    const expectedReason = process.platform === 'win32' ? 'in-use' : 'permission-denied'
    expect(result.errors).toEqual([{ path: locked, reason: expectedReason }])
    expect(result.needsElevation).toBe(process.platform !== 'win32')
  })

  it('unlinks directory junctions without traversing their targets', async () => {
    const { root } = createTree()
    const external = join(testDir, 'keep-external')
    const externalFile = join(external, 'keep.dat')
    mkdirSync(external)
    writeFileSync(externalFile, 'keep')
    try {
      symlinkSync(external, join(root, 'external-link'), 'junction')
    } catch {
      return // Unprivileged Windows without junction creation support.
    }
    state.rootPath = root
    state.rootFailuresRemaining = process.platform === 'win32' ? 2 : 1

    const result = await safeDelete(root)

    expect(result.success).toBe(true)
    expect(existsSync(root)).toBe(false)
    expect(existsSync(externalFile)).toBe(true)
  })
})
