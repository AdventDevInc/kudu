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

import { cleanItems, scanDirectory } from './file-utils'

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
