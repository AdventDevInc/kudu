import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'path'
import { IPC } from '../../shared/channels'
import type { LargeFileDeleteResult, LargeFileScanResult } from '../../shared/types'

const { handlers, readdir, lstat, rm, trashItem } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  readdir: vi.fn(),
  lstat: vi.fn(),
  rm: vi.fn(),
  trashItem: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(channel, handler)
  },
  shell: { trashItem }
}))
vi.mock('fs/promises', () => ({ readdir, lstat, rm }))
vi.mock('./open-dialog', () => ({ showOpenDialog: vi.fn() }))

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

function fileEntry(name = 'archive.zip') {
  return {
    name,
    isFile: () => true,
    isDirectory: () => false,
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

  it('keeps a failed deletion available for retry', async () => {
    await scan()
    trashItem.mockRejectedValueOnce(new Error('File is busy'))
    expect((await remove()).failed).toBe(1)
    expect((await remove()).deleted).toBe(1)
  })

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
