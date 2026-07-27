import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./settings-store', () => ({
  getSettings: () => ({ cleaner: { secureDelete: false, skipRecentMinutes: 60 }, exclusions: [] }),
}))

vi.mock('./scan-cache', () => ({ getCachedItems: () => [] }))

import { scanDirectory } from './file-utils'

let testDir: string

/** A file whose mtime is `minutesAgo` in the past. */
function file(name: string, minutesAgo: number, bytes = 32): string {
  const path = join(testDir, name)
  writeFileSync(path, Buffer.alloc(bytes))
  const when = new Date(Date.now() - minutesAgo * 60 * 1000)
  utimesSync(path, when, when)
  return path
}

/** A directory holding one file, with the directory's own mtime set to `minutesAgo`. */
function dir(name: string, minutesAgo: number, bytes = 64): string {
  const path = join(testDir, name)
  mkdirSync(path)
  writeFileSync(join(path, 'entry'), Buffer.alloc(bytes))
  const when = new Date(Date.now() - minutesAgo * 60 * 1000)
  utimesSync(path, when, when)
  return path
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'kudu-recency-'))
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('scanDirectory recency guard', () => {
  it('skips both recent files and recent directories by default', async () => {
    file('hot.bin', 1)
    dir('hot-dir', 1)
    file('cold.bin', 180)

    const result = await scanDirectory(testDir, 'browser', 'Test')
    expect(result.items.map((i) => i.path)).toEqual([join(testDir, 'cold.bin')])
  })

  // Issue #265: Chrome's `Code Cache` holds only the `js` and `wasm`
  // directories, whose mtimes move on every write, so the guard discarded the
  // whole cache — ~310 MB — and the empty result was then dropped entirely.
  it('keeps a recently touched directory when the guard is files-only', async () => {
    dir('hot-dir', 1)
    file('cold.bin', 180)

    const result = await scanDirectory(testDir, 'browser', 'Test', { filesOnly: true })
    expect(result.items.map((i) => i.path).sort()).toEqual(
      [join(testDir, 'cold.bin'), join(testDir, 'hot-dir')].sort()
    )
    expect(result.totalSize).toBe(64 + 32)
  })

  // A running browser keeps `data_0`-`data_3` and `index` memory-mapped, so
  // they must stay out of a scan even with the directory exemption on.
  it('still skips recently written files when the guard is files-only', async () => {
    file('data_0', 1)
    file('f_00001', 180)

    const result = await scanDirectory(testDir, 'browser', 'Test', { filesOnly: true })
    expect(result.items.map((i) => i.path)).toEqual([join(testDir, 'f_00001')])
  })

  it('accepts a plain number as the cutoff, as before', async () => {
    file('hot.bin', 1)
    dir('hot-dir', 1)

    const guarded = await scanDirectory(testDir, 'browser', 'Test', 60)
    expect(guarded.items).toHaveLength(0)

    const ungated = await scanDirectory(testDir, 'browser', 'Test', 0)
    expect(ungated.items).toHaveLength(2)
  })
})
