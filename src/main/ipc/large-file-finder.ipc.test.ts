import { beforeEach, describe, expect, it, vi } from 'vitest'
import { basename, join, resolve } from 'path'
import { tmpdir } from 'os'
import { IPC } from '../../shared/channels'
import type { LargeFileDeleteResult, LargeFileScanResult } from '../../shared/types'

const { handlers, readdir, lstat, rm, trashItem, settings } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  readdir: vi.fn(),
  lstat: vi.fn(),
  rm: vi.fn(),
  trashItem: vi.fn(),
  settings: { exclusions: [] as string[] }
}))

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(channel, handler)
  },
  shell: { trashItem }
}))
vi.mock('fs/promises', () => ({ readdir, lstat, rm, realpath: async (path: string) => path }))
vi.mock('./open-dialog', () => ({ showOpenDialog: vi.fn() }))
vi.mock('../services/settings-store', () => ({ getSettings: () => settings }))

import { registerLargeFileFinderIpc } from './large-file-finder.ipc'

const directory = resolve('large-file-test')
const filePath = join(directory, 'archive.zip')
const fileSize = 20_000_000n
const identity = {
  dev: 1n,
  ino: 123n,
  size: fileSize,
  mtimeMs: 1000n,
  mtimeNs: 1_000_000_000n,
  ctimeNs: 1_000_000_000n,
  isFile: () => true,
  isSymbolicLink: () => false
}

function fileEntry(name = 'archive.zip', isDirectory = false) {
  return {
    name,
    isFile: () => !isDirectory,
    isDirectory: () => isDirectory,
    isSymbolicLink: () => false
  }
}

function scan(options: unknown = { directory }) {
  return handlers.get(IPC.LARGE_FILES_SCAN)!(null, options) as Promise<LargeFileScanResult>
}

function remove(paths: string[] = [filePath], mode = 'recycle') {
  return handlers.get(IPC.LARGE_FILES_DELETE)!(null, paths, mode) as Promise<LargeFileDeleteResult>
}

describe('Large File Finder scan and deletion safety', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    handlers.clear()
    settings.exclusions = []
    registerLargeFileFinderIpc(() => null)
    await scan(null) // Invalidate results left by the previous test.
    readdir.mockResolvedValue([fileEntry()])
    lstat.mockResolvedValue(identity)
    rm.mockResolvedValue(undefined)
    trashItem.mockResolvedValue(undefined)
  })

  it.each(['recycle', 'permanent'])(
    'deletes an unchanged scanned file in %s mode',
    async (mode) => {
      const result = await scan()
      expect(result.files).toEqual([
        {
          path: filePath,
          name: 'archive.zip',
          size: Number(fileSize),
          lastModified: 1000,
          extension: '.zip'
        }
      ])
      expect(() => JSON.stringify(result)).not.toThrow()
      expect(await remove([filePath], mode)).toEqual({
        deleted: 1,
        failed: 0,
        spaceRecovered: Number(fileSize),
        errors: []
      })
      if (mode === 'permanent') {
        expect(rm).toHaveBeenCalledWith(filePath)
        expect(trashItem).not.toHaveBeenCalled()
      } else {
        expect(trashItem).toHaveBeenCalledWith(filePath)
        expect(rm).not.toHaveBeenCalled()
      }
    }
  )

  it('does not descend into excluded directories or list excluded files', async () => {
    const excludedDir = join(directory, 'vault')
    readdir.mockImplementation(async (path: string) =>
      path === directory
        ? [fileEntry(), fileEntry('movie.mkv'), fileEntry('vault', true)]
        : [fileEntry('secret.zip')]
    )
    settings.exclusions = [excludedDir, '*.mkv']
    expect((await scan()).files.map((file) => file.path)).toEqual([filePath])
    expect(readdir.mock.calls.map(([path]) => path)).not.toContain(excludedDir)
  })

  it('returns nothing when the scan root itself is excluded', async () => {
    settings.exclusions = [directory]
    expect((await scan()).files).toEqual([])
    expect(readdir).not.toHaveBeenCalled()
  })

  it.each(['recycle', 'permanent'])(
    'refuses to delete a file excluded after the scan in %s mode',
    async (mode) => {
      await scan()
      settings.exclusions = ['*.zip']
      expect(await remove([filePath], mode)).toEqual({
        deleted: 0,
        failed: 1,
        spaceRecovered: 0,
        errors: [{ path: filePath, reason: 'excluded' }]
      })
      expect(trashItem).not.toHaveBeenCalled()
      expect(rm).not.toHaveBeenCalled()
    }
  )

  it('rejects paths that were not returned by a scan before reading them', async () => {
    const result = await remove()
    expect(result.failed).toBe(1)
    expect(result.errors[0].reason).toContain('not in the current scan')
    expect(lstat).not.toHaveBeenCalled()
    expect(trashItem).not.toHaveBeenCalled()
    expect(rm).not.toHaveBeenCalled()
  })

  it.each([
    ['size', { size: fileSize + 1n }],
    ['modification time', { mtimeNs: identity.mtimeNs + 1n }],
    ['change time', { ctimeNs: identity.ctimeNs + 1n }],
    ['inode', { ino: identity.ino + 1n }],
    ['device', { dev: identity.dev + 1n }],
    ['directory replacement', { isFile: () => false }],
    ['symlink replacement', { isSymbolicLink: () => true }]
  ])('rejects a file with changed %s', async (_label, changes) => {
    await scan()
    lstat.mockResolvedValue({ ...identity, ...changes })
    const result = await remove()
    expect(result).toMatchObject({ deleted: 0, failed: 1, spaceRecovered: 0 })
    expect(result.errors[0].reason).toContain('changed since the scan')
    expect(trashItem).not.toHaveBeenCalled()
    expect(rm).not.toHaveBeenCalled()
  })

  it('skips a directory entry replaced by a symlink before metadata is read', async () => {
    lstat.mockResolvedValue({ ...identity, isSymbolicLink: () => true })
    expect((await scan()).files).toEqual([])
    expect((await remove()).failed).toBe(1)
  })

  it('deduplicates deletion requests and consumes successful selections', async () => {
    await scan()
    expect(await remove([filePath, filePath])).toMatchObject({ deleted: 1, failed: 0 })
    expect((await remove()).failed).toBe(1)
    expect(trashItem).toHaveBeenCalledTimes(1)
  })

  it.each(['recycle', 'permanent'])(
    'refreshes hard-link change times after each successful %s deletion',
    async (mode) => {
      const paths = [filePath, join(directory, 'link2.zip'), join(directory, 'link3.zip')]
      readdir.mockResolvedValue([fileEntry(), fileEntry('link2.zip'), fileEntry('link3.zip')])
      let ctimeNs = identity.ctimeNs
      lstat.mockImplementation(async () => ({ ...identity, ctimeNs }))
      const deleteFile = mode === 'permanent' ? rm : trashItem
      deleteFile.mockImplementation(async () => {
        ctimeNs++
      })
      await scan()

      expect(await remove(paths.slice(0, 2), mode)).toMatchObject({ deleted: 2, failed: 0 })
      // Also refresh unselected links so a later delete does not require a rescan.
      expect(await remove(paths.slice(2), mode)).toMatchObject({ deleted: 1, failed: 0 })
      expect(deleteFile).toHaveBeenCalledTimes(3)
    }
  )

  it('keeps a failed deletion available for retry', async () => {
    await scan()
    trashItem.mockRejectedValueOnce(new Error('File is busy'))
    expect((await remove()).failed).toBe(1)
    expect((await remove()).deleted).toBe(1)
  })

  it.each([
    ['content size', { size: fileSize + 1n }],
    ['content modification', { mtimeNs: identity.mtimeNs + 1n }],
    ['replacement inode', { ino: identity.ino + 1n }],
    ['replacement device', { dev: identity.dev + 1n }],
    ['symlink', { isSymbolicLink: () => true }]
  ])('does not adopt a hard link with changed %s during refresh', async (_label, changes) => {
    const linkedPath = join(directory, 'linked.zip')
    readdir.mockResolvedValue([fileEntry(), fileEntry('linked.zip')])
    await scan()
    trashItem.mockImplementationOnce(async () => {
      lstat.mockResolvedValue({ ...identity, ...changes, ctimeNs: identity.ctimeNs + 1n })
    })
    expect(await remove([filePath, linkedPath])).toMatchObject({ deleted: 1, failed: 1 })
    expect(trashItem).toHaveBeenCalledTimes(1)
  })

  it('does not refresh change times on an unrelated file', async () => {
    const otherPath = join(directory, 'other.zip')
    readdir.mockResolvedValue([fileEntry(), fileEntry('other.zip')])
    let ctimeNs = identity.ctimeNs
    lstat.mockImplementation(async (path: string) => ({
      ...identity,
      ino: path === otherPath ? identity.ino + 1n : identity.ino,
      ctimeNs
    }))
    await scan()
    trashItem.mockImplementationOnce(async () => {
      ctimeNs++
    })
    expect(await remove([filePath, otherPath])).toMatchObject({ deleted: 1, failed: 1 })
    expect(trashItem).toHaveBeenCalledTimes(1)
  })

  it('preserves successful deletion accounting when a hard-link refresh fails', async () => {
    const linkedPath = join(directory, 'linked.zip')
    readdir.mockResolvedValue([fileEntry(), fileEntry('linked.zip')])
    await scan()
    trashItem.mockImplementationOnce(async () => {
      lstat.mockRejectedValueOnce(new Error('EACCES'))
    })
    expect(await remove()).toMatchObject({
      deleted: 1,
      failed: 0,
      spaceRecovered: Number(fileSize)
    })
    lstat.mockResolvedValue({ ...identity, ctimeNs: identity.ctimeNs + 1n })
    expect((await remove([linkedPath])).failed).toBe(1)
  })

  it('does not group files when their inode is unknown', async () => {
    const linkedPath = join(directory, 'linked.zip')
    readdir.mockResolvedValue([fileEntry(), fileEntry('linked.zip')])
    lstat.mockResolvedValue({ ...identity, ino: 0n })
    await scan()
    trashItem.mockImplementationOnce(async () => {
      lstat.mockResolvedValue({ ...identity, ino: 0n, ctimeNs: identity.ctimeNs + 1n })
    })
    expect(await remove([filePath, linkedPath])).toMatchObject({ deleted: 1, failed: 1 })
  })

  it.each(['recycle', 'permanent'])(
    'deletes real hard links in %s mode without a stale-identity failure',
    async (mode) => {
      const fs = await vi.importActual<typeof import('fs/promises')>('fs/promises')
      const fixture = await fs.mkdtemp(join(tmpdir(), 'kudu-large-links-'))
      try {
        const first = join(fixture, 'first.txt')
        const second = join(fixture, 'second.txt')
        await fs.writeFile(first, 'hard-link regression fixture')
        await fs.link(first, second)
        readdir.mockImplementation(fs.readdir)
        lstat.mockImplementation(fs.lstat)
        rm.mockImplementation(fs.rm)
        // Exercise a real same-volume move without touching the user's Recycle Bin.
        trashItem.mockImplementation(async (path: string) => {
          await fs.rename(path, join(fixture, 'recycled', basename(path)))
        })
        const result = await scan({ directory: fixture, minFileSize: 1 })
        expect(result.files).toHaveLength(2)
        await fs.mkdir(join(fixture, 'recycled'))
        expect(await remove([first, second], mode)).toMatchObject({ deleted: 2, failed: 0 })
        await expect(fs.lstat(first)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(fs.lstat(second)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        // Only the unique directory created by this test is removed.
        await fs.rm(fixture, { recursive: true, force: true })
      }
    }
  )

  it('does not report space recovered if a file disappears during permanent deletion', async () => {
    await scan()
    rm.mockRejectedValueOnce(new Error('ENOENT'))
    expect(await remove([filePath], 'permanent')).toMatchObject({
      deleted: 0,
      failed: 1,
      spaceRecovered: 0
    })
  })

  it('invalidates old selections even when the next scan cannot read its root', async () => {
    await scan()
    readdir.mockRejectedValueOnce(new Error('Access denied'))
    expect((await scan()).files).toEqual([])
    expect((await remove()).failed).toBe(1)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('authorizes only the 500 displayed results', async () => {
    readdir.mockResolvedValue(Array.from({ length: 501 }, (_, i) => fileEntry(`${i}.zip`)))
    lstat.mockImplementation(async (path: string) => ({
      ...identity,
      size: fileSize + BigInt(Number(path.split(/[\\/]/).pop()!.split('.')[0]))
    }))
    const result = await scan()
    expect(result.files).toHaveLength(500)
    expect(result.files[0].name).toBe('500.zip')
    expect((await remove([join(directory, '0.zip')])).failed).toBe(1)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('rejects overlapping scans and deletion without resetting cancellation', async () => {
    let release!: (entries: ReturnType<typeof fileEntry>[]) => void
    readdir.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const pending = scan()
    await expect(scan()).rejects.toThrow('already in progress')
    await expect(remove()).rejects.toThrow('already in progress')
    handlers.get(IPC.LARGE_FILES_CANCEL)!()
    release([fileEntry()])
    expect((await pending).cancelled).toBe(true)
    expect((await scan()).cancelled).toBe(false)
  })

  it('rejects overlapping operations during deletion and releases the guard afterward', async () => {
    await scan()
    let release!: () => void
    trashItem.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const pending = remove()
    await vi.waitFor(() => expect(trashItem).toHaveBeenCalledTimes(1))
    await expect(remove()).rejects.toThrow('already in progress')
    await expect(scan()).rejects.toThrow('already in progress')
    release()
    expect((await pending).deleted).toBe(1)
    expect((await scan()).files).toHaveLength(1)
  })
})
