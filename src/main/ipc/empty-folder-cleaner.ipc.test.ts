import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join, parse, relative, resolve, sep } from 'path'
import { IPC } from '../../shared/channels'
import type { EmptyFolderDeleteResult, EmptyFolderScanResult } from '../../shared/types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  readdir: vi.fn(),
  rmdir: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  trashItem: vi.fn(),
  homedir: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler)
  },
  shell: { trashItem: mocks.trashItem }
}))
vi.mock('fs/promises', () => ({
  readdir: mocks.readdir,
  rmdir: mocks.rmdir,
  lstat: mocks.lstat,
  realpath: mocks.realpath
}))
vi.mock('os', () => ({ homedir: mocks.homedir }))
vi.mock('./open-dialog', () => ({ showOpenDialog: vi.fn() }))
import { registerEmptyFolderCleanerIpc } from './empty-folder-cleaner.ipc'

// All filesystem calls are mocked; these fixtures are never deletion targets.
const root = join(parse(resolve('.')).root, 'Users', 'CleanerTest')
const directory = join(root, 'projects')
const empty = join(directory, 'empty')
const systemName = process.platform === 'win32' ? 'Windows' : 'usr'
const canonicalHome = join(
  parse(root).root,
  process.platform === 'win32' ? 'Windows' : 'var',
  'home',
  'CleanerTest'
)

function mapCanonicalHome() {
  mocks.realpath.mockImplementation(async (path: string) =>
    path === root || path.startsWith(root + sep) ? join(canonicalHome, relative(root, path)) : path
  )
}
function entry(name: string, kind: 'directory' | 'file' | 'symlink' | 'other' = 'directory') {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink'
  }
}
function scan(options: unknown = { directory }) {
  return mocks.handlers.get(IPC.EMPTY_FOLDERS_SCAN)!(
    null,
    options
  ) as Promise<EmptyFolderScanResult>
}
function remove(paths: unknown = [empty], mode = 'recycle') {
  return mocks.handlers.get(IPC.EMPTY_FOLDERS_DELETE)!(
    null,
    paths,
    mode
  ) as Promise<EmptyFolderDeleteResult>
}

describe('Empty Folder Cleaner production handlers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.handlers.clear()
    registerEmptyFolderCleanerIpc(() => null)
    mocks.homedir.mockReturnValue(root)
    mocks.realpath.mockImplementation(async (path: string) => path)
    mocks.lstat.mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false })
    mocks.readdir.mockResolvedValue([])
    mocks.rmdir.mockResolvedValue(undefined)
    mocks.trashItem.mockResolvedValue(undefined)
  })
  it('finds empty descendants deepest first without selecting the scan root', async () => {
    mocks.readdir.mockImplementation(async (path: string) => {
      if (path === directory) return [entry('empty')]
      if (path === empty) return [entry('nested')]
      return []
    })
    const result = await scan()
    expect(result.folders.map((folder) => folder.path)).toEqual([join(empty, 'nested'), empty])
    expect(result.totalFoldersScanned).toBe(3)
  })
  it.each(['node_modules', 'AppData', '.ssh', systemName])(
    'does not traverse protected %s trees or mark their parents empty',
    async (name) => {
      mocks.readdir.mockImplementation(async (path: string) => {
        if (path === directory) return [entry('container')]
        if (path === join(directory, 'container')) return [entry(name)]
        return [entry('empty-child')]
      })
      expect((await scan()).folders).toEqual([])
      expect(mocks.readdir.mock.calls.map(([path]) => path)).toEqual([
        directory,
        join(directory, 'container')
      ])
    }
  )
  it.each(['node_modules', 'AppData', systemName])(
    'rejects scan roots inside protected %s trees',
    async (name) => {
      expect((await scan({ directory: join(directory, name, 'child') })).folders).toEqual([])
      expect(mocks.readdir).not.toHaveBeenCalled()
    }
  )
  it('rejects a scan root redirected into a protected tree', async () => {
    mocks.realpath.mockImplementation(async (path: string) =>
      path === root ? root : join(directory, 'node_modules', 'package')
    )
    expect((await scan()).folders).toEqual([])
    expect(mocks.readdir).not.toHaveBeenCalled()
  })
  it('allows scanning Documents while protecting the profile folder itself', async () => {
    const documents = join(root, 'Documents')
    mocks.readdir.mockImplementation(async (path: string) =>
      path === documents ? [entry('empty')] : []
    )
    expect((await scan({ directory: documents })).folders.map((folder) => folder.path)).toEqual([
      join(documents, 'empty')
    ])
    expect((await remove([documents])).failed).toBe(1)
    expect(mocks.trashItem).not.toHaveBeenCalled()
  })
  it.each(['file', 'symlink', 'other'] as const)('treats %s entries as content', async (kind) => {
    mocks.readdir.mockImplementation(async (path: string) =>
      path === directory ? [entry('empty')] : [entry('content', kind)]
    )
    expect((await scan()).folders).toEqual([])
  })
  it('respects depth limits and case-insensitive user exclusions', async () => {
    mocks.readdir.mockImplementation(async (path: string) => {
      if (path === directory) return [entry('BUILD'), entry('empty')]
      if (path === empty) return [entry('too-deep')]
      return []
    })
    expect((await scan({ directory, maxDepth: 1, excludePatterns: ['build'] })).folders).toEqual([])
    expect(mocks.readdir.mock.calls.map(([path]) => path)).toEqual([directory, empty])
  })
  it('treats unreadable children as non-empty', async () => {
    mocks.readdir.mockResolvedValueOnce([entry('empty')]).mockRejectedValueOnce(new Error('EACCES'))
    expect((await scan()).folders).toEqual([])
  })
  it.each([null, 'invalid', { directory: 'relative' }])(
    'rejects invalid scan options %j',
    async (options) => {
      expect((await scan(options)).folders).toEqual([])
      expect(mocks.readdir).not.toHaveBeenCalled()
    }
  )
  it.each(['recycle', 'permanent'])('deletes a regular empty folder in %s mode', async (mode) => {
    expect(await remove([empty], mode)).toEqual({ deleted: 1, failed: 0, errors: [] })
    expect(mode === 'permanent' ? mocks.rmdir : mocks.trashItem).toHaveBeenCalledWith(empty)
    expect(mode === 'permanent' ? mocks.trashItem : mocks.rmdir).not.toHaveBeenCalled()
  })
  it.each(['recycle', 'permanent'])('protects system descendants in %s mode', async (mode) => {
    const paths = [join(directory, systemName, 'child'), join(directory, 'node_modules', 'child')]
    expect(await remove(paths, mode)).toMatchObject({ deleted: 0, failed: 2 })
    expect(mocks.readdir).not.toHaveBeenCalled()
    expect(mocks.rmdir).not.toHaveBeenCalled()
    expect(mocks.trashItem).not.toHaveBeenCalled()
  })
  it('normalizes dot segments and trailing separators before checking protection', async () => {
    expect((await remove([`${empty}/../node_modules/`])).failed).toBe(1)
    expect(mocks.readdir).not.toHaveBeenCalled()
  })
  it('protects filesystem roots and root-level folders', async () => {
    const drive = parse(directory).root
    expect(await remove([drive, join(drive, 'Users')])).toMatchObject({ deleted: 0, failed: 2 })
    expect(mocks.readdir).not.toHaveBeenCalled()
  })
  it('rejects protected targets reached through a parent directory alias', async () => {
    mocks.realpath.mockImplementation(async (path: string) =>
      path === root ? root : join(directory, systemName, 'child')
    )
    expect((await remove()).failed).toBe(1)
    expect(mocks.readdir).not.toHaveBeenCalled()
    expect(mocks.trashItem).not.toHaveBeenCalled()
  })
  it.each([
    { isDirectory: () => true, isSymbolicLink: () => true },
    { isDirectory: () => false, isSymbolicLink: () => false }
  ])('rejects paths that are no longer regular directories', async (metadata) => {
    mocks.lstat.mockResolvedValue(metadata)
    expect((await remove()).failed).toBe(1)
    expect(mocks.readdir).not.toHaveBeenCalled()
    expect(mocks.trashItem).not.toHaveBeenCalled()
  })
  it('does not delete folders that gained content after scanning', async () => {
    mocks.readdir.mockResolvedValue(['new-file.txt'])
    expect((await remove()).failed).toBe(1)
    expect(mocks.trashItem).not.toHaveBeenCalled()
  })
  it('deduplicates normalized paths and deletes children before parents', async () => {
    const nested = join(empty, 'nested')
    expect(await remove([empty, nested, `${empty}/nested/`])).toEqual({
      deleted: 2,
      failed: 0,
      errors: []
    })
    expect(mocks.trashItem.mock.calls.map(([path]) => path)).toEqual([nested, empty])
  })
  it('reports failures while continuing with other folders', async () => {
    mocks.trashItem.mockRejectedValueOnce(new Error('EACCES'))
    expect(await remove([empty, join(directory, 'another')])).toMatchObject({
      deleted: 1,
      failed: 1
    })
  })

  it.each([root, canonicalHome])('scans user folders beneath canonical home %s', async (home) => {
    mapCanonicalHome()
    const selected = join(home, 'Documents')
    mocks.readdir.mockImplementation(async (path: string) =>
      path === selected ? [entry('empty')] : []
    )
    expect((await scan({ directory: selected })).folders.map((folder) => folder.path)).toEqual([
      join(selected, 'empty')
    ])
  })

  it.each(['recycle', 'permanent'])(
    'deletes ordinary folders in a canonical home in %s mode',
    async (mode) => {
      mapCanonicalHome()
      expect(await remove([empty, join(canonicalHome, 'another')], mode)).toMatchObject({
        deleted: 2,
        failed: 0
      })
    }
  )

  it('still protects special folders inside both home paths', async () => {
    mapCanonicalHome()
    for (const home of [root, canonicalHome]) {
      for (const name of ['.ssh', 'node_modules', systemName]) {
        const path = join(home, name, 'child')
        expect((await scan({ directory: path })).folders).toEqual([])
        expect((await remove([path])).failed).toBe(1)
      }
      expect((await remove([home, join(home, 'Documents')])).failed).toBe(2)
    }
    expect(mocks.readdir).not.toHaveBeenCalled()
    expect(mocks.trashItem).not.toHaveBeenCalled()
  })

  it('does not exempt a sibling home sharing a path prefix', async () => {
    mapCanonicalHome()
    const sibling = join(canonicalHome + '-other', 'empty')
    expect((await scan({ directory: sibling })).folders).toEqual([])
    expect((await remove([sibling])).failed).toBe(1)
    expect(mocks.readdir).not.toHaveBeenCalled()
  })

  it('does not exempt protected ancestors when canonical home resolution fails', async () => {
    mocks.realpath.mockImplementation(async (path: string) => {
      if (path === root) throw new Error('EACCES')
      return path
    })
    const path = join(canonicalHome, 'empty')
    expect((await scan({ directory: path })).folders).toEqual([])
    expect((await remove([path])).failed).toBe(1)
  })
})
