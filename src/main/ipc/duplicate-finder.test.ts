import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  mkdtempSync,
  symlinkSync,
  linkSync,
  lstatSync,
  realpathSync,
  renameSync,
  utimesSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { IPC } from '../../shared/channels'
import type { DuplicateDeleteResult, DuplicateScanResult } from '../../shared/types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  trashItem: vi.fn(),
  settings: { exclusions: [] as string[] },
  /** Called before every realpath, so a test can act mid-verification. */
  onRealpath: null as ((path: string) => void) | null
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    realpath: (async (path: string) => {
      mocks.onRealpath?.(path)
      return actual.realpath(path)
    }) as typeof actual.realpath
  }
})

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler)
  },
  shell: { trashItem: mocks.trashItem, showItemInFolder: vi.fn() }
}))
vi.mock('./open-dialog', () => ({ showOpenDialog: vi.fn() }))
vi.mock('../services/settings-store', () => ({ getSettings: () => mocks.settings }))

import { registerDuplicateFinderIpc } from './duplicate-finder.ipc'

// We test the exported scan functions by creating a temp directory
// with known duplicate files and scanning it via the module's internals.
// Since groupBySize and hash functions are private, we test through
// the exported analyzeDisk-style pattern by importing what we can.

// For now, test file creation and hashing correctness with crypto directly
import { createHash } from 'crypto'

const TEST_DIR = join(tmpdir(), `kudu-dup-test-${Date.now()}`)

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  mkdirSync(join(TEST_DIR, 'subdir'), { recursive: true })
  mkdirSync(join(TEST_DIR, 'node_modules'), { recursive: true })

  // Create two identical files (duplicates)
  const content = 'A'.repeat(2_000_000) // 2MB to exceed default minFileSize
  writeFileSync(join(TEST_DIR, 'file1.txt'), content)
  writeFileSync(join(TEST_DIR, 'subdir', 'file1_copy.txt'), content)

  // Create a unique file (same size different content)
  const uniqueContent = 'B'.repeat(2_000_000)
  writeFileSync(join(TEST_DIR, 'unique.txt'), uniqueContent)

  // Create a small file (should be skipped by default minFileSize)
  writeFileSync(join(TEST_DIR, 'small.txt'), 'tiny')

  // Create a file in node_modules (should be excluded by default)
  writeFileSync(join(TEST_DIR, 'node_modules', 'dep.txt'), content)
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('duplicate finder hashing', () => {
  it('identical files produce the same SHA-256 hash', () => {
    const content = 'A'.repeat(2_000_000)
    const hash1 = createHash('sha256').update(content).digest('hex')
    const hash2 = createHash('sha256').update(content).digest('hex')
    expect(hash1).toBe(hash2)
  })

  it('different files produce different SHA-256 hashes', () => {
    const hash1 = createHash('sha256').update('A'.repeat(2_000_000)).digest('hex')
    const hash2 = createHash('sha256').update('B'.repeat(2_000_000)).digest('hex')
    expect(hash1).not.toBe(hash2)
  })

  it('partial hash (first 4KB) of identical files matches', () => {
    const content = 'C'.repeat(100_000)
    const partial = content.slice(0, 4096)
    const hash1 = createHash('sha256').update(partial).digest('hex')
    const hash2 = createHash('sha256').update(partial).digest('hex')
    expect(hash1).toBe(hash2)
  })

  it('partial hash of files differing only after 4KB still matches partial', () => {
    const base = 'D'.repeat(4096)
    const content1 = base + 'X'.repeat(10000)
    const content2 = base + 'Y'.repeat(10000)
    const partial1 = createHash('sha256').update(content1.slice(0, 4096)).digest('hex')
    const partial2 = createHash('sha256').update(content2.slice(0, 4096)).digest('hex')
    // Partial hashes should match since first 4KB is identical
    expect(partial1).toBe(partial2)
    // But full hashes should differ
    const full1 = createHash('sha256').update(content1).digest('hex')
    const full2 = createHash('sha256').update(content2).digest('hex')
    expect(full1).not.toBe(full2)
  })
})

describe('duplicate finder options validation', () => {
  it('DuplicateScanOptions type allows null maxFileSize', () => {
    const opts = {
      directory: TEST_DIR,
      minFileSize: 1_048_576,
      maxFileSize: null,
      excludePatterns: ['node_modules'],
      extensionFilter: [],
      maxDepth: 20
    }
    expect(opts.maxFileSize).toBeNull()
    expect(opts.minFileSize).toBe(1_048_576)
  })

  it('extension filter comparison is case-sensitive in options', () => {
    const exts = ['.jpg', '.png']
    expect(exts.includes('.JPG')).toBe(false)
    expect(exts.includes('.jpg')).toBe(true)
  })

  it('exclude patterns match case-insensitively', () => {
    const patterns = ['node_modules', '.git']
    const dirName = 'Node_Modules'
    const matches = patterns.some((p) => dirName === p || dirName.toLowerCase() === p.toLowerCase())
    expect(matches).toBe(true)
  })

  it('exclude patterns do not match partial directory names', () => {
    const patterns = ['node_modules']
    const dirName = 'my_node_modules_backup'
    const matches = patterns.some((p) => dirName === p || dirName.toLowerCase() === p.toLowerCase())
    expect(matches).toBe(false)
  })
})

describe('duplicate group reclaimable space calculation', () => {
  it('calculates reclaimable as fileSize * (copies - 1)', () => {
    const fileSize = 5_000_000
    const fileCount = 4
    const reclaimable = fileSize * (fileCount - 1)
    expect(reclaimable).toBe(15_000_000)
  })

  it('two files means one copy is reclaimable', () => {
    const fileSize = 1_000_000
    const reclaimable = fileSize * (2 - 1)
    expect(reclaimable).toBe(1_000_000)
  })

  it('single file group has zero reclaimable (should be filtered)', () => {
    const fileSize = 1_000_000
    const reclaimable = fileSize * (1 - 1)
    expect(reclaimable).toBe(0)
  })
})

describe('duplicate finder global exclusions', () => {
  let root: string

  function scan(directory = root) {
    return mocks.handlers.get(IPC.DUPLICATES_SCAN)!(null, {
      directory,
      minFileSize: 1
    }) as Promise<DuplicateScanResult>
  }

  function remove(paths: string[]) {
    return mocks.handlers.get(IPC.DUPLICATES_DELETE)!(
      null,
      paths,
      'permanent'
    ) as Promise<DuplicateDeleteResult>
  }

  beforeEach(() => {
    mocks.handlers.clear()
    mocks.settings.exclusions = []
    registerDuplicateFinderIpc(() => null)
    // Scans walk the real path (e.g. /private/var on macOS), so compare against it.
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kudu-dup-exclusions-')))
    mkdirSync(join(root, 'keep'))
    for (const name of ['a.bin', 'b.bin', 'c.log', join('keep', 'd.bin')]) {
      writeFileSync(join(root, name), 'same content')
    }
    return () => rmSync(root, { recursive: true, force: true })
  })

  it('skips excluded directories and extensions while scanning', async () => {
    mocks.settings.exclusions = [join(root, 'keep'), '*.log']
    const result = await scan()
    const paths = result.groups.flatMap((g) => g.files.map((f) => f.path)).sort()
    expect(paths).toEqual([join(root, 'a.bin'), join(root, 'b.bin')])
  })

  it('returns nothing when the scan root itself is excluded', async () => {
    mocks.settings.exclusions = [root]
    expect((await scan()).groups).toEqual([])
  })

  it('refuses to delete a path excluded after the scan', async () => {
    await scan()
    mocks.settings.exclusions = [join(root, 'keep')]
    const excluded = join(root, 'keep', 'd.bin')
    const result = await remove([excluded])
    expect(result).toMatchObject({ deleted: 0, failed: 1 })
    expect(result.errors).toEqual([{ path: excluded, reason: 'excluded' }])
    expect(existsSync(excluded)).toBe(true)
  })
})

describe('duplicate finder deletion safety', () => {
  let root: string
  // The shortest path is listed first, so `a` is the copy kept by default.
  let a: string
  let bb: string
  let ccc: string

  function scan() {
    return mocks.handlers.get(IPC.DUPLICATES_SCAN)!(null, {
      directory: root,
      minFileSize: 1
    }) as Promise<DuplicateScanResult>
  }

  function remove(paths: string[], mode = 'permanent') {
    return mocks.handlers.get(IPC.DUPLICATES_DELETE)!(
      null,
      paths,
      mode
    ) as Promise<DuplicateDeleteResult>
  }

  /** Create a link, or skip on Windows hosts that do not permit it. */
  function tryLink(create: () => void, ctx: { skip: (note?: string) => void }): boolean {
    try {
      create()
      return true
    } catch (err: any) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(err.code)) {
        ctx.skip('Windows does not permit creating the test link')
        return false
      }
      throw err
    }
  }

  beforeEach(() => {
    mocks.handlers.clear()
    mocks.settings.exclusions = []
    mocks.trashItem.mockReset()
    mocks.onRealpath = null
    registerDuplicateFinderIpc(() => null)
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kudu-dup-safety-')))
    // Reverse alphabetical, so listing order cannot come from directory order.
    a = join(root, 'z.bin')
    bb = join(root, 'yy.bin')
    ccc = join(root, 'xxx.bin')
    for (const path of [a, bb, ccc]) writeFileSync(path, 'same content')
    return () => rmSync(root, { recursive: true, force: true })
  })

  it('lists the shortest path first in each group', async () => {
    const result = await scan()
    expect(result.groups.map((g) => g.files.map((f) => f.path))).toEqual([[a, bb, ccc]])
  })

  it.each(['recycle', 'permanent'])('deletes verified duplicates in %s mode', async (mode) => {
    await scan()
    const result = await remove([bb, ccc], mode)
    expect(result).toEqual({ deleted: 2, failed: 0, spaceRecovered: 24, errors: [] })
    if (mode === 'recycle') {
      expect(mocks.trashItem.mock.calls.map(([path]) => path)).toEqual([bb, ccc])
    } else {
      expect(mocks.trashItem).not.toHaveBeenCalled()
      expect([a, bb, ccc].map((p) => existsSync(p))).toEqual([true, false, false])
    }
  })

  it('keeps the first-listed copy when every copy is requested', async () => {
    await scan()
    const result = await remove([ccc, bb, a])
    expect(result).toMatchObject({ deleted: 2, failed: 1 })
    expect(result.errors).toEqual([
      { path: a, reason: 'Kept as the last copy of this duplicate group' }
    ])
    expect(existsSync(a)).toBe(true)

    // The survivor stays protected across requests too.
    expect(await remove([a])).toMatchObject({ deleted: 0, failed: 1 })
    expect(existsSync(a)).toBe(true)
  })

  it('rejects paths that were not returned by the last scan', async () => {
    const outside = join(mkdtempSync(join(root, 'other-')), 'x.bin')
    await scan()
    writeFileSync(outside, 'same content')
    const result = await remove([outside, join(root, 'missing.bin')])
    expect(result).toMatchObject({ deleted: 0, failed: 2 })
    expect(result.errors.every((e) => e.reason.includes('not in the current scan'))).toBe(true)
    expect(existsSync(outside)).toBe(true)
  })

  it('invalidates the previous results when a new scan starts', async () => {
    await scan()
    await mocks.handlers.get(IPC.DUPLICATES_SCAN)!(null, null)
    expect(await remove([bb])).toMatchObject({ deleted: 0, failed: 1 })
    expect(existsSync(bb)).toBe(true)
  })

  it('skips a file whose content changed since the scan', async () => {
    await scan()
    writeFileSync(bb, 'SAME content') // Same size, different bytes.
    const result = await remove([bb])
    expect(result).toMatchObject({ deleted: 0, failed: 1 })
    expect(result.errors[0].reason).toContain('changed since the scan')
    expect(existsSync(bb)).toBe(true)
  })

  it('skips a file when no other copy still holds the same content', async () => {
    rmSync(ccc)
    await scan()
    writeFileSync(a, 'SAME content')
    const result = await remove([bb])
    expect(result).toMatchObject({ deleted: 0, failed: 1 })
    expect(result.errors[0].reason).toContain('No other intact copy')
    expect(existsSync(bb)).toBe(true)
  })

  it('keeps a hard-linked file and only deletes the copy that frees space', async (ctx) => {
    rmSync(ccc)
    // bb has a second name outside the scanned folder, so deleting it frees nothing.
    const outside = mkdtempSync(join(tmpdir(), 'kudu-dup-links-'))
    try {
      if (!tryLink(() => linkSync(bb, join(outside, 'alias.bin')), ctx)) return
      const [group] = (await scan()).groups
      expect(group.files.map((f) => f.path)).toEqual([bb, a])
      expect(group.files.map((f) => f.hardLinked === true)).toEqual([true, false])
      expect(group.reclaimableSpace).toBe(12)

      const refused = await remove([bb])
      expect(refused.errors[0].reason).toContain('Other hard links')
      expect(existsSync(bb)).toBe(true)

      expect(await remove([a])).toMatchObject({ deleted: 1, spaceRecovered: 12 })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('keeps a target rewritten in place with its mtime restored during verification', async () => {
    rmSync(ccc)
    await scan()
    const original = lstatSync(bb)
    // While the survivor is being checked, rewrite bb with same-size unique bytes
    // and put its modification time back: only ctime can reveal the change.
    mocks.onRealpath = (path) => {
      if (path === a) {
        mocks.onRealpath = null
        writeFileSync(bb, 'SAME CONTENT')
        utimesSync(bb, original.atime, original.mtime)
      }
    }
    const result = await remove([bb])
    expect(result).toMatchObject({ deleted: 0, failed: 1 })
    expect(result.errors[0].reason).toContain('changed while it was being verified')
    expect(existsSync(bb)).toBe(true)
  })

  it('does not count a survivor that changed while it was being hashed', async () => {
    rmSync(ccc)
    await scan()
    // Touch the survivor's mtime after its pre-hash checks: same bytes, same hash,
    // but no longer provably the file that was verified.
    let calls = 0
    mocks.onRealpath = (path) => {
      if (path === a && ++calls === 2) {
        mocks.onRealpath = null
        const later = new Date(Date.now() + 60_000)
        utimesSync(a, later, later)
      }
    }
    const result = await remove([bb])
    expect(result).toMatchObject({ deleted: 0, failed: 1 })
    expect(result.errors[0].reason).toContain('No other intact copy')
    expect(existsSync(bb)).toBe(true)
  })

  it('stops once earlier deletions leave only one intact copy', async () => {
    await scan()
    writeFileSync(a, 'SAME content') // The default survivor no longer matches.
    const result = await remove([bb, ccc])
    expect(result).toMatchObject({ deleted: 1, failed: 1 })
    expect(result.errors).toEqual([{ path: ccc, reason: expect.stringContaining('No other') }])
    expect(existsSync(ccc)).toBe(true)
  })

  it('skips a file replaced by a symlink and never counts a symlink as a survivor', async (ctx) => {
    rmSync(ccc)
    await scan()
    rmSync(bb)
    if (!tryLink(() => symlinkSync(a, bb, 'file'), ctx)) return
    let result = await remove([bb])
    expect(result.errors[0].reason).toContain('no longer a regular file')
    expect(lstatSync(bb).isSymbolicLink()).toBe(true)

    // With the only other member now a symlink to it, `a` must be kept.
    result = await remove([a])
    expect(result).toMatchObject({ deleted: 0, failed: 1 })
    expect(existsSync(a)).toBe(true)
  })

  it('does not offer hard links to the same file as duplicates', async (ctx) => {
    rmSync(bb)
    rmSync(ccc)
    if (!tryLink(() => linkSync(a, bb), ctx)) return
    expect((await scan()).groups).toEqual([])

    writeFileSync(ccc, 'same content')
    // Only one of the two links is offered, alongside the real copy.
    const [group] = (await scan()).groups
    const paths = group.files.map((f) => f.path)
    expect(paths).toHaveLength(2)
    expect(paths).toContain(ccc)
    expect(group.reclaimableSpace).toBe(12)
  })

  it('does not treat a hard link to the target as its surviving copy', async (ctx) => {
    rmSync(ccc)
    await scan()
    rmSync(a)
    if (!tryLink(() => linkSync(bb, a), ctx)) return
    const result = await remove([bb])
    expect(result).toMatchObject({ deleted: 0, failed: 1 })
    // bb now has a second name, so it is refused before survivors are even checked.
    expect(result.errors[0].reason).toContain('Other hard links')
    expect(existsSync(bb)).toBe(true)
  })

  it('rejects a path redirected through an ancestor replaced by a link', async (ctx) => {
    // yy.bin lives in dir/; after the scan, dir/ is moved away and replaced by a
    // junction to a different folder holding a same-content file.
    const dir = join(root, 'dir')
    mkdirSync(dir)
    rmSync(bb)
    const inDir = join(dir, 'yy.bin')
    writeFileSync(inDir, 'same content')
    await scan()
    const elsewhere = mkdtempSync(join(tmpdir(), 'kudu-dup-elsewhere-'))
    try {
      writeFileSync(join(elsewhere, 'yy.bin'), 'same content')
      renameSync(dir, join(root, 'dir-moved'))
      if (!tryLink(() => symlinkSync(elsewhere, dir, 'junction'), ctx)) return
      const result = await remove([inDir])
      expect(result).toMatchObject({ deleted: 0, failed: 1 })
      expect(result.errors[0].reason).toContain('moved or replaced')
      expect(existsSync(join(elsewhere, 'yy.bin'))).toBe(true)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('keeps a file that changes while its survivors are being verified', async () => {
    rmSync(ccc)
    await scan()
    // The survivor check for `a` runs after bb was hashed; rewrite bb then.
    mocks.onRealpath = (path) => {
      if (path === a) {
        mocks.onRealpath = null
        writeFileSync(bb, 'different content, now unique')
      }
    }
    const result = await remove([bb])
    expect(result).toMatchObject({ deleted: 0, failed: 1 })
    expect(result.errors[0].reason).toContain('changed while it was being verified')
    expect(existsSync(bb)).toBe(true)
  })

  it('keeps a target excluded while its survivors were being verified', async () => {
    rmSync(ccc)
    await scan()
    // The exclusion arrives after the request started, during survivor checks.
    mocks.onRealpath = (path) => {
      if (path === a) {
        mocks.onRealpath = null
        mocks.settings.exclusions = [bb]
      }
    }
    const result = await remove([bb])
    expect(result.errors).toEqual([{ path: bb, reason: 'excluded' }])
    expect(existsSync(bb)).toBe(true)
  })

  it('never opens an excluded file as the surviving copy', async () => {
    rmSync(ccc)
    await scan()
    // After the scan, the only other copy becomes excluded.
    mocks.settings.exclusions = [a]
    const result = await remove([bb])
    expect(result).toMatchObject({ deleted: 0, failed: 1 })
    expect(result.errors[0].reason).toContain('No other intact copy')
    expect(existsSync(bb)).toBe(true)
  })

  it('rejects an overlapping deletion request', async () => {
    await scan()
    let release!: () => void
    mocks.trashItem.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)))
    const pending = remove([bb], 'recycle')
    await vi.waitFor(() => expect(mocks.trashItem).toHaveBeenCalledTimes(1))
    await expect(remove([ccc], 'recycle')).rejects.toThrow('already in progress')
    release()
    expect((await pending).deleted).toBe(1)
  })
})
