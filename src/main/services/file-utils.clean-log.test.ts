import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DeletedFileRecord, ScanItem } from '../../shared/types'

const state = vi.hoisted(() => ({
  keepDeletionLog: false,
  items: [] as any[],
  recorded: [] as any[],
  batches: 0,
  failRm: false,
}))

// Pass through to the real fs, with a switch to force a delete failure so we
// can assert nothing is logged for a directory that survived.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) =>
      state.failRm
        ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
        : actual.rm(...args),
  }
})

vi.mock('./settings-store', () => ({
  getSettings: () => ({
    cleaner: {
      secureDelete: false,
      skipRecentMinutes: 60,
      keepDeletionLog: state.keepDeletionLog,
    },
    exclusions: [],
  }),
}))

vi.mock('./scan-cache', () => ({
  getCachedItems: () => state.items,
}))

vi.mock('./deletion-log-store', () => ({
  recordDeletions: (records: DeletedFileRecord[]) => {
    state.batches++
    state.recorded.push(...records)
  },
}))

import { cleanItems } from './file-utils'

let testDir: string

/** Create `count` real files and register them as cached scan items. */
function seedItems(count: number, subcategory = 'Temp Files'): ScanItem[] {
  const items: ScanItem[] = []
  for (let i = 0; i < count; i++) {
    const path = join(testDir, `file-${i}.tmp`)
    writeFileSync(path, 'x'.repeat(10), 'utf-8')
    items.push({
      id: `id-${i}`,
      path,
      size: 10,
      category: 'system',
      subcategory,
      lastModified: 0,
      selected: true,
    })
  }
  state.items = items
  return items
}

describe('cleanItems deletion logging', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'kudu-cleanlog-test-'))
    state.keepDeletionLog = false
    state.items = []
    state.recorded = []
    state.batches = 0
    state.failRm = false
  })

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('records nothing when the setting is off', async () => {
    seedItems(3)
    const result = await cleanItems(['id-0', 'id-1', 'id-2'])

    expect(result.filesDeleted).toBe(3)
    expect(state.recorded).toHaveLength(0)
    expect(state.batches).toBe(0)
  })

  it('records one entry per deleted file when the setting is on', async () => {
    state.keepDeletionLog = true
    const items = seedItems(3)
    const result = await cleanItems(['id-0', 'id-1', 'id-2'])

    expect(result.filesDeleted).toBe(3)
    expect(state.recorded).toHaveLength(3)
    expect(state.recorded.map((r) => r.path).sort()).toEqual(items.map((i) => i.path).sort())
    for (const record of state.recorded) {
      expect(record.size).toBe(10)
      expect(record.category).toBe('Temp Files')
      expect(Number.isNaN(Date.parse(record.ts))).toBe(false)
    }
  })

  it('falls back to the broad category when an item has no subcategory', async () => {
    state.keepDeletionLog = true
    seedItems(1, '')
    await cleanItems(['id-0'])

    expect(state.recorded[0].category).toBe('system')
  })

  it('flushes in batches so a large clean never buffers everything', async () => {
    state.keepDeletionLog = true
    seedItems(1200)
    const ids = Array.from({ length: 1200 }, (_, i) => `id-${i}`)

    const result = await cleanItems(ids)

    expect(result.filesDeleted).toBe(1200)
    expect(state.recorded).toHaveLength(1200)
    // 500 + 500 + a final flush of the 200 remainder.
    expect(state.batches).toBe(3)
  })

  it('tags records with the calling surface, defaulting to local', async () => {
    state.keepDeletionLog = true
    seedItems(1)
    await cleanItems(['id-0'])
    expect(state.recorded[0].origin).toBe('local')

    state.recorded = []
    seedItems(1)
    await cleanItems(['id-0'], undefined, 'cloud')
    expect(state.recorded[0].origin).toBe('cloud')
  })

  it('records every file inside a directory that was removed recursively', async () => {
    state.keepDeletionLog = true
    const dir = join(testDir, 'cache')
    mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true })
    writeFileSync(join(dir, 'top.dat'), 'a', 'utf-8')
    writeFileSync(join(dir, 'nested', 'mid.dat'), 'b', 'utf-8')
    writeFileSync(join(dir, 'nested', 'deeper', 'leaf.dat'), 'c', 'utf-8')

    state.items = [{
      id: 'dir-0',
      path: dir,
      size: 3,
      category: 'system',
      subcategory: 'App Cache',
      lastModified: 0,
      selected: true,
    }]

    const result = await cleanItems(['dir-0'])
    expect(result.filesDeleted).toBe(1)
    expect(existsSync(dir)).toBe(false)

    const logged = state.recorded.map((r) => r.path).sort()
    expect(logged).toEqual([
      dir,
      join(dir, 'nested'),
      join(dir, 'nested', 'deeper'),
      join(dir, 'nested', 'deeper', 'leaf.dat'),
      join(dir, 'nested', 'mid.dat'),
      join(dir, 'top.dat'),
    ].sort())

    // Bytes stay on the directory record so a CSV sum doesn't double-count.
    expect(state.recorded.find((r) => r.path === dir).size).toBe(3)
    expect(state.recorded.find((r) => r.path === join(dir, 'top.dat')).size).toBe(0)
    for (const record of state.recorded) {
      expect(record.category).toBe('App Cache')
    }
  })

  it('does not expand a directory when logging is off', async () => {
    const dir = join(testDir, 'cache')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'top.dat'), 'a', 'utf-8')
    state.items = [{
      id: 'dir-0', path: dir, size: 1, category: 'system',
      subcategory: 'App Cache', lastModified: 0, selected: true,
    }]

    await cleanItems(['dir-0'])
    expect(state.recorded).toHaveLength(0)
  })

  it('records nothing for a directory whose deletion failed', async () => {
    state.keepDeletionLog = true
    const dir = join(testDir, 'cache')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'top.dat'), 'a', 'utf-8')
    state.items = [{
      id: 'dir-0', path: dir, size: 1, category: 'system',
      subcategory: 'App Cache', lastModified: 0, selected: true,
    }]

    // Fail the delete after the descendants were already enumerated.
    state.failRm = true
    const result = await cleanItems(['dir-0'])

    expect(result.filesDeleted).toBe(0)
    expect(result.needsElevation).toBe(true)
    expect(state.recorded).toHaveLength(0)
  })

  it('does not log a path that was already gone before the clean', async () => {
    state.keepDeletionLog = true
    seedItems(1)
    // A temp file that disappeared between the scan and the clean: rm(force)
    // still reports success, but Kudu did not delete it.
    state.items.push({
      id: 'id-vanished',
      path: join(testDir, 'vanished.tmp'),
      size: 500,
      category: 'system',
      subcategory: 'Temp Files',
      lastModified: 0,
      selected: true,
    })

    const result = await cleanItems(['id-0', 'id-vanished'])

    expect(result.filesDeleted).toBe(2) // counters keep their existing behavior
    expect(state.recorded.map((r) => r.path)).toEqual([join(testDir, 'file-0.tmp')])
  })

  it('does not expand a symlinked directory, which rm only unlinks', async () => {
    state.keepDeletionLog = true
    const target = join(testDir, 'real-target')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'keep-me.dat'), 'a', 'utf-8')

    const link = join(testDir, 'link-to-target')
    try {
      symlinkSync(target, link, 'junction')
    } catch {
      return // Unprivileged Windows without Developer Mode — nothing to assert.
    }

    state.items = [{
      id: 'link-0', path: link, size: 1, category: 'system',
      subcategory: 'App Cache', lastModified: 0, selected: true,
    }]

    await cleanItems(['link-0'])

    // Only the link itself: its target's files are still on disk.
    expect(state.recorded.map((r) => r.path)).toEqual([link])
    expect(existsSync(join(target, 'keep-me.dat'))).toBe(true)
  })

  it('does not log when no items match the given ids', async () => {
    state.keepDeletionLog = true
    state.items = []
    await cleanItems(['nope'])

    expect(state.recorded).toHaveLength(0)
    expect(state.batches).toBe(0)
  })
})
