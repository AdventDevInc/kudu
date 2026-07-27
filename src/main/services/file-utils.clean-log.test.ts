import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DeletedFileRecord, ScanItem } from '../../shared/types'

const state = vi.hoisted(() => ({
  keepDeletionLog: false,
  items: [] as any[],
  recorded: [] as any[],
  batches: 0,
}))

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

  it('records exactly the files that were actually deleted', async () => {
    state.keepDeletionLog = true
    seedItems(2)
    // A third item pointing at a path that was never created — rm treats a
    // missing path as already-gone, so it still counts as deleted.
    state.items.push({
      id: 'id-missing',
      path: join(testDir, 'never-existed.tmp'),
      size: 0,
      category: 'system',
      subcategory: 'Temp Files',
      lastModified: 0,
      selected: true,
    })

    const result = await cleanItems(['id-0', 'id-1', 'id-missing'])
    expect(state.recorded).toHaveLength(result.filesDeleted)
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

  it('does not log when no items match the given ids', async () => {
    state.keepDeletionLog = true
    state.items = []
    await cleanItems(['nope'])

    expect(state.recorded).toHaveLength(0)
    expect(state.batches).toBe(0)
  })
})
