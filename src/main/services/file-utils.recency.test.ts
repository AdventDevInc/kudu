import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const state = vi.hoisted(() => ({
  exclusions: [] as string[],
  items: [] as Array<{ id: string }>,
}))

vi.mock('./settings-store', () => ({
  getSettings: () => ({ cleaner: { secureDelete: false, skipRecentMinutes: 60 }, exclusions: state.exclusions }),
}))

vi.mock('./scan-cache', () => ({
  getCachedItems: (ids: string[]) => state.items.filter((item) => ids.includes(item.id)),
  removeCachedItems: (ids: string[]) => { state.items = state.items.filter((item) => !ids.includes(item.id)) },
}))

import { cleanItems, scanDirectory, scanDirectoriesAsItems, scanFile } from './file-utils'

const DEEP = { deepRecencyCheck: true }

let testDir: string

function ago(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000)
}

/** A file `minutesAgo` old, creating parent directories as needed. */
function file(relPath: string, minutesAgo: number, bytes = 32): string {
  const path = join(testDir, relPath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes))
  utimesSync(path, ago(minutesAgo), ago(minutesAgo))
  return path
}

/** Set a directory's own mtime, leaving its contents alone. */
function touchDir(relPath: string, minutesAgo: number): string {
  const path = join(testDir, relPath)
  utimesSync(path, ago(minutesAgo), ago(minutesAgo))
  return path
}

function paths(result: { items: Array<{ path: string }> }): string[] {
  return result.items.map((i) => i.path).sort()
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'kudu-recency-'))
  state.exclusions = []
  state.items = []
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('scanDirectory recency guard', () => {
  it('protects recent and excluded descendants with the default options', async () => {
    const recent = file('old/live', 1)
    const excluded = file('old/keep', 180)
    const stale = file('old/stale', 180)
    touchDir('old', 180)
    state.exclusions = [excluded]
    const result = await scanDirectory(testDir, 'system', 'Test')
    expect(paths(result)).toEqual([stale])
    state.items = result.items
    await cleanItems(result.items.map(i => i.id))
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(excluded)).toBe(true)
    expect(existsSync(stale)).toBe(false)
  })

  it('checks new exclusions added after scanning a whole folder', async () => {
    const keep = file('old/keep', 180)
    const result = await scanDirectory(testDir, 'system', 'Test')
    state.items = result.items
    state.exclusions = [keep]
    const cleaned = await cleanItems(result.items.map(i => i.id))
    expect(cleaned.filesDeleted).toBe(0)
    expect(cleaned.errors).toEqual([{ path: join(testDir, 'old'), reason: 'excluded' }])
    expect(existsSync(keep)).toBe(true)
  })

  it('rechecks a file updated after a default scan', async () => {
    const keep = file('keep', 180)
    const result = await scanDirectory(testDir, 'app', 'Test')
    state.items = result.items
    utimesSync(keep, ago(0), ago(0))
    expect((await cleanItems(result.items.map(i => i.id))).filesDeleted).toBe(0)
    expect(existsSync(keep)).toBe(true)
  })

  it('protects live descendants when scanning whole gaming directories', async () => {
    file('cache/live', 1)
    const stale = file('cache/stale', 180, 2048)
    const result = await scanDirectoriesAsItems([join(testDir, 'cache')], 'gaming', 'Test')
    expect(paths(result)).toEqual([stale])
    expect(result.items[0].recencyCutoff).toBeTypeOf('number')
  })

  it('withholds empty and sub-1-KiB gaming cache items', async () => {
    mkdirSync(join(testDir, 'empty'))
    file('small/data', 180, 1023)
    file('mixed/live', 1, 4096)
    file('mixed/tiny', 180, 512)
    const eligible = file('mixed/eligible', 180, 1024)
    const result = await scanDirectoriesAsItems(
      ['empty', 'small', 'mixed'].map(name => join(testDir, name)), 'gaming', 'Test')
    expect(paths(result)).toEqual([eligible])
    expect(result.totalSize).toBe(1024)
  })

  it('reports completion when all selected files become excluded', async () => {
    const keep = file('keep', 180)
    const result = await scanDirectory(testDir, 'system', 'Test')
    state.items = result.items
    state.exclusions = [keep]
    const progress = vi.fn()
    const cleaned = await cleanItems(result.items.map(item => item.id), progress)
    expect(cleaned.filesSkipped).toBe(1)
    expect(progress).toHaveBeenLastCalledWith(1, 1, keep, 0)
    expect(existsSync(keep)).toBe(true)
  })

  it('does not offer a freshly written single-file target', async () => {
    const keep = file('MEMORY.DMP', 1)
    expect((await scanFile(keep, 'system', 'dump')).items).toEqual([])
  })
  it('skips recent files and recent directories by default', async () => {
    file('hot.bin', 1)
    file('hot-dir/entry', 1)
    touchDir('hot-dir', 1)
    file('cold.bin', 180)

    const result = await scanDirectory(testDir, 'browser', 'Test')
    expect(paths(result)).toEqual([join(testDir, 'cold.bin')])
  })

  it('accepts a plain number as the cutoff, as before', async () => {
    file('hot.bin', 1)
    file('hot-dir/entry', 1)
    touchDir('hot-dir', 1)

    expect((await scanDirectory(testDir, 'browser', 'Test', 60)).items).toHaveLength(0)
    expect((await scanDirectory(testDir, 'browser', 'Test', 0)).items).toHaveLength(2)
  })
})

describe('scanDirectory with deepRecencyCheck', () => {
  // Issue #265: Chrome's `Code Cache` holds only the `js` and `wasm`
  // directories. Their mtimes move on every write, so judging them directly
  // discarded ~310 MB and the empty result was then dropped entirely.
  it('keeps a directory whose own mtime is recent but whose contents are settled', async () => {
    file('js/entry', 180, 300)
    file('wasm/entry', 180, 10)
    touchDir('js', 1)
    touchDir('wasm', 1)

    const result = await scanDirectory(testDir, 'browser', 'Test', DEEP)
    expect(paths(result)).toEqual([join(testDir, 'js'), join(testDir, 'wasm')].sort())
    expect(result.totalSize).toBe(310)
  })

  // The hole Codex found in the first attempt: admitting the directory whole
  // means safeDelete recurses into it, so a live descendant would be removed —
  // and securely overwritten in place — underneath a running browser.
  it('never offers a directory that still holds a live file', async () => {
    file('js/settled', 180, 100)
    file('js/live', 1, 5)

    const result = await scanDirectory(testDir, 'browser', 'Test', DEEP)
    expect(paths(result)).toEqual([join(testDir, 'js', 'settled')])
    expect(result.totalSize).toBe(100)
  })

  it('checks descendants all the way down, not just one level', async () => {
    file('a/b/c/settled', 180, 100)
    file('a/b/c/live', 1, 5)
    file('a/other/settled', 180, 20)

    const result = await scanDirectory(testDir, 'browser', 'Test', DEEP)
    expect(paths(result)).toEqual([
      join(testDir, 'a', 'b', 'c', 'settled'),
      join(testDir, 'a', 'other'),
    ].sort())
    expect(result.totalSize).toBe(120)
  })

  // A running browser keeps `data_0`-`data_3` and `index` memory-mapped.
  it('still skips recently written files at the top level', async () => {
    file('data_0', 1)
    file('f_00001', 180)

    const result = await scanDirectory(testDir, 'browser', 'Test', DEEP)
    expect(paths(result)).toEqual([join(testDir, 'f_00001')])
  })

  it('does not silently truncate a flat cache after 5,000 settled files', async () => {
    for (let i = 0; i < 5_001; i++) file(`entry-${i}`, 180, 1)

    const result = await scanDirectory(testDir, 'browser', 'Large flat cache', DEEP)

    expect(result.itemCount).toBe(5_001)
    expect(result.totalSize).toBe(5_001)
  }, 30_000)

  it('collapses a fully settled tree into one item per top-level entry', async () => {
    file('js/a', 180, 10)
    file('js/index-dir/the-real-index', 180, 5)

    const result = await scanDirectory(testDir, 'browser', 'Test', DEEP)
    expect(paths(result)).toEqual([join(testDir, 'js')])
    expect(result.totalSize).toBe(15)
  })

  it('revalidates a collapsed directory immediately before recursive deletion', async () => {
    file('js/settled', 180, 10)
    const scan = await scanDirectory(testDir, 'browser', 'Test', DEEP)
    const directory = join(testDir, 'js')
    expect(scan.items).toHaveLength(1)
    expect(scan.items[0].recencyCutoff).toEqual(expect.any(Number))

    state.items = scan.items
    file('js/created-after-scan', 1, 5)
    const cleaned = await cleanItems([scan.items[0].id])

    expect(cleaned.filesDeleted).toBe(0)
    expect(cleaned.filesSkipped).toBe(1)
    expect(cleaned.errors).toContainEqual({ path: directory, reason: 'recently-modified' })
    expect(existsSync(directory)).toBe(true)
    expect(existsSync(join(directory, 'created-after-scan'))).toBe(true)
  })

  it('still deletes a collapsed directory when every descendant remains settled', async () => {
    file('js/settled', 180, 10)
    const scan = await scanDirectory(testDir, 'browser', 'Test', DEEP)
    const directory = join(testDir, 'js')
    state.items = scan.items

    const cleaned = await cleanItems([scan.items[0].id])

    expect(cleaned.filesDeleted).toBe(1)
    expect(cleaned.filesSkipped).toBe(0)
    expect(existsSync(directory)).toBe(false)
  })

  it('reports nothing when every entry is live', async () => {
    file('js/live', 1)

    const result = await scanDirectory(testDir, 'browser', 'Test', DEEP)
    expect(result.items).toHaveLength(0)
    expect(result.itemCount).toBe(0)
  })

  // The top-level scan only ever tested the entries it listed, so a directory
  // could be offered whole and then recursively deleted along with an excluded
  // file buried inside it. Descending closes that off too.
  it('never offers a directory holding an excluded descendant', async () => {
    file('js/settled', 180, 100)
    file('js/keep-me.txt', 180, 7)
    state.exclusions = [join(testDir, 'js', 'keep-me.txt')]

    const result = await scanDirectory(testDir, 'browser', 'Test', DEEP)
    expect(paths(result)).toEqual([join(testDir, 'js', 'settled')])
    expect(result.totalSize).toBe(100)
  })

  it('honours an *.ext exclusion below the top level', async () => {
    file('js/settled', 180, 100)
    file('js/nested/notes.log', 180, 7)
    state.exclusions = ['*.log']

    const result = await scanDirectory(testDir, 'browser', 'Test', DEEP)
    expect(paths(result)).toEqual([join(testDir, 'js', 'settled')])
  })
})
