import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from 'fs/promises'
import { dirname, join, parse } from 'path'
import { homedir, tmpdir } from 'os'
import { assertCustomFolderPath, CustomFolders } from './custom-folders'
import { mountPoints } from './mount-points'

vi.mock('./mount-points', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mount-points')>()),
  mountPoints: vi.fn(async () => new Set<string>())
}))

describe('Custom folders', () => {
  let fixture: string, root: string, store: string, exclusions: string[]
  let trash: ReturnType<typeof vi.fn>, folders: CustomFolders
  beforeEach(async () => {
    fixture = await realpath(await mkdtemp(join(tmpdir(), 'kudu-custom-folders-')))
    root = join(fixture, 'portable', 'cache')
    store = join(fixture, 'userData', 'custom-folders.json')
    await mkdir(root, { recursive: true })
    exclusions = []
    vi.mocked(mountPoints).mockResolvedValue(new Set())
    trash = vi.fn(async (path: string) => {
      await unlink(path)
    })
    folders = new CustomFolders(store, async () => exclusions, trash)
  })
  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true })
  })

  it('rejects broad, protected, relative, network and wildcard targets', () => {
    for (const path of [
      parse(root).root,
      homedir(),
      dirname(homedir()),
      join(homedir(), 'Documents'),
      'relative/cache',
      root + '/*',
      '\\\\server\\cache',
      root + '\0'
    ])
      expect(() => assertCustomFolderPath(path)).toThrow()
    const protectedPath =
      process.platform === 'win32'
        ? join(process.env.WINDIR || 'C:\\Windows', 'Temp')
        : '/usr/cache'
    expect(() => assertCustomFolderPath(protectedPath)).toThrow()
    expect(() => assertCustomFolderPath(root)).not.toThrow()
    if (process.platform === 'win32') {
      expect(() => assertCustomFolderPath('Q:/PortableApps/ExampleApp/cache')).not.toThrow()
      for (const path of ['//server/share/cache', '\\cache', '/cache', 'Q:cache'])
        expect(() => assertCustomFolderPath(path)).toThrow()
    }
  })

  it('persists canonical targets across restarts and removes targets without deleting files', async () => {
    await writeFile(join(root, 'keep.log'), 'keep')
    const [target] = await folders.add(' Portable cache ', root)
    expect(target.name).toBe('Portable cache')
    const restarted = new CustomFolders(store, async () => exclusions, trash)
    expect(await restarted.list()).toEqual([target])
    expect(await restarted.remove(target.id)).toEqual([])
    expect(await readFile(join(root, 'keep.log'), 'utf8')).toBe('keep')
    expect(trash).not.toHaveBeenCalled()
  })

  it('rejects overlapping folders and linked roots/ancestors', async () => {
    await folders.add('Cache', root)
    await expect(folders.add('Duplicate', root)).rejects.toThrow('overlaps')
    await expect(folders.add('Parent', dirname(root))).rejects.toThrow('overlaps')
    await mkdir(join(root, 'nested'))
    await expect(folders.add('Nested', join(root, 'nested'))).rejects.toThrow('overlaps')
    const alias = join(fixture, 'alias')
    await symlink(dirname(root), alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(folders.add('Linked', join(alias, 'cache'))).rejects.toThrow('Linked')
  })

  it('recursively previews files, respects exclusions and skips links and recovery folders', async () => {
    await mkdir(join(root, 'nested'))
    await mkdir(join(root, 'Kudu Custom Folder Recovery-existing'))
    await writeFile(join(root, 'Kudu Custom Folder Recovery-existing', 'held.log'), 'held')
    await writeFile(join(root, 'nested', 'one.log'), 'data')
    await writeFile(join(root, 'skip.tmp'), 'skip')
    await link(join(root, 'nested', 'one.log'), join(root, 'linked.log'))
    await writeFile(join(root, 'good.log'), 'good')
    await symlink(
      join(root, 'nested'),
      join(root, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    exclusions = ['*.tmp']
    const [target] = await folders.add('Cache', root)
    const result = await folders.scan(target.id)
    expect(result.files.map((file) => file.path)).toEqual(['good.log'])
    expect(result.skipped).toBe(5)
    expect(trash).not.toHaveBeenCalled()
  })

  it('moves only explicitly selected scan IDs to Trash, once, leaving folders and new files', async () => {
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'one.log'), 'one')
    await writeFile(join(root, 'two.log'), 'two')
    const [target] = await folders.add('Cache', root)
    const scan = await folders.scan(target.id)
    const selected = scan.files.find((file) => file.path.endsWith('one.log'))!
    await writeFile(join(root, 'nested', 'new.log'), 'new')
    const result = await folders.trashSelected(scan.scanId, [
      selected.id,
      selected.id,
      join(root, 'two.log')
    ])
    expect(result.trashedIds).toEqual([selected.id])
    expect(result.skippedIds).toEqual([join(root, 'two.log')])
    expect(trash).toHaveBeenCalledOnce()
    expect(trash.mock.calls[0][0]).toContain('Kudu Custom Folder Recovery-')
    expect(await readFile(join(root, 'two.log'), 'utf8')).toBe('two')
    expect(await readFile(join(root, 'nested', 'new.log'), 'utf8')).toBe('new')
    expect((await folders.trashSelected(scan.scanId, [selected.id])).skippedIds).toEqual([
      selected.id
    ])
  })

  it('skips modified/replaced files, new hard links and exclusions changed since scanning', async () => {
    for (const name of ['changed.log', 'replaced.log', 'linked.log', 'excluded.log'])
      await writeFile(join(root, name), 'data')
    const [target] = await folders.add('Cache', root)
    const scan = await folders.scan(target.id)
    await writeFile(join(root, 'changed.log'), 'changed')
    await rename(join(root, 'replaced.log'), join(root, 'old.log'))
    await writeFile(join(root, 'replaced.log'), 'data')
    await link(join(root, 'linked.log'), join(root, 'hardlink.log'))
    exclusions = [join(root, 'excluded.log')]
    const result = await folders.trashSelected(
      scan.scanId,
      scan.files.map((file) => file.id)
    )
    expect(result.skippedIds).toHaveLength(4)
    expect(trash).not.toHaveBeenCalled()
  })

  it('skips a nested directory replaced with a junction or an ordinary directory', async () => {
    const nested = join(root, 'nested')
    await mkdir(nested)
    await writeFile(join(nested, 'one.log'), 'data')
    const [target] = await folders.add('Cache', root)
    const scan = await folders.scan(target.id)
    const old = join(fixture, 'old')
    await rename(nested, old)
    await symlink(old, nested, process.platform === 'win32' ? 'junction' : 'dir')
    expect((await folders.trashSelected(scan.scanId, [scan.files[0].id])).skippedIds).toHaveLength(
      1
    )
    await rm(nested)
    await mkdir(nested)
    await writeFile(join(nested, 'one.log'), 'data')
    expect((await folders.trashSelected(scan.scanId, [scan.files[0].id])).skippedIds).toHaveLength(
      1
    )
    expect(trash).not.toHaveBeenCalled()
  })

  it('expires previews on a new scan or target configuration change', async () => {
    await writeFile(join(root, 'one.log'), 'data')
    const [target] = await folders.add('Cache', root)
    const old = await folders.scan(target.id)
    const current = await folders.scan(target.id)
    await expect(folders.trashSelected(old.scanId, [old.files[0].id])).rejects.toThrow('expired')
    await folders.remove(target.id)
    await expect(folders.trashSelected(current.scanId, [current.files[0].id])).rejects.toThrow(
      'expired'
    )
    expect(trash).not.toHaveBeenCalled()
  })

  it('restores files when OS Trash is unavailable, without permanent deletion', async () => {
    await writeFile(join(root, 'one.log'), 'data')
    trash.mockRejectedValue(new Error('Trash unavailable'))
    const [target] = await folders.add('Cache', root)
    const scan = await folders.scan(target.id)
    expect((await folders.trashSelected(scan.scanId, [scan.files[0].id])).skippedIds).toHaveLength(
      1
    )
    expect(await readFile(join(root, 'one.log'), 'utf8')).toBe('data')
  })

  it('preserves claimed files and reports recovery paths if rollback would overwrite a replacement', async () => {
    await writeFile(join(root, 'one.log'), 'original')
    trash.mockImplementation(async () => {
      await writeFile(join(root, 'one.log'), 'replacement')
      throw new Error('Trash unavailable')
    })
    const [target] = await folders.add('Cache', root)
    const scan = await folders.scan(target.id)
    const result = await folders.trashSelected(scan.scanId, [scan.files[0].id])
    expect(result.skippedIds).toHaveLength(1)
    expect(result.recoveryPaths).toHaveLength(1)
    expect(await readFile(result.recoveryPaths![0], 'utf8')).toBe('original')
    expect(await readFile(join(root, 'one.log'), 'utf8')).toBe('replacement')
    expect((await folders.scan(target.id)).files.map((file) => file.path)).toEqual(['one.log'])
  })

  it('reports partial previews when reaching the depth limit', async () => {
    let nested = root
    for (let i = 0; i < 22; i++) {
      nested = join(nested, 'd')
      await mkdir(nested)
    }
    await writeFile(join(nested, 'deep.log'), 'data')
    const [target] = await folders.add('Cache', root)
    const result = await folders.scan(target.id)
    expect(result.limited).toBe(true)
    expect(result.files).toEqual([])
  })

  it('skips mounted filesystems during scanning and mounts introduced before cleanup', async () => {
    const nested = join(root, 'mounted')
    await mkdir(nested)
    await writeFile(join(nested, 'one.log'), 'data')
    await writeFile(join(root, 'two.log'), 'data')
    const [target] = await folders.add('Cache', root)
    vi.mocked(mountPoints).mockResolvedValue(new Set([nested]))
    const partial = await folders.scan(target.id)
    expect(partial.files.map((file) => file.path)).toEqual(['two.log'])
    vi.mocked(mountPoints).mockResolvedValue(new Set())
    const full = await folders.scan(target.id)
    vi.mocked(mountPoints).mockResolvedValue(new Set([nested, join(root, 'two.log')]))
    expect(
      (
        await folders.trashSelected(
          full.scanId,
          full.files.map((file) => file.id)
        )
      ).skippedIds
    ).toHaveLength(2)
    expect(trash).not.toHaveBeenCalled()
  })

  it('fails closed on an excluded or replaced root and corrupted configuration', async () => {
    await writeFile(join(root, 'one.log'), 'data')
    const [target] = await folders.add('Cache', root)
    exclusions = [root]
    await expect(folders.scan(target.id)).rejects.toThrow('excluded')
    exclusions = []
    const scan = await folders.scan(target.id)
    await rename(root, join(fixture, 'old-cache'))
    await mkdir(root)
    await writeFile(join(root, 'one.log'), 'data')
    expect((await folders.trashSelected(scan.scanId, [scan.files[0].id])).skippedIds).toHaveLength(
      1
    )
    expect(trash).not.toHaveBeenCalled()
    await writeFile(store, '{corrupt')
    await expect(folders.add('Cache', root)).rejects.toThrow()
    expect(await readFile(store, 'utf8')).toBe('{corrupt')
  })

  it('serializes mutations with cleanup and rejects malformed selections', async () => {
    await writeFile(join(root, 'one.log'), 'data')
    const [target] = await folders.add('Cache', root)
    const scan = await folders.scan(target.id)
    await expect(folders.trashSelected(scan.scanId, null as unknown as string[])).rejects.toThrow(
      'Invalid'
    )
    await expect(folders.trashSelected(scan.scanId, [12] as unknown as string[])).rejects.toThrow(
      'Invalid'
    )
    let finish!: () => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    trash.mockImplementation(async (path: string) => {
      started()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      await unlink(path)
    })
    const moving = folders.trashSelected(scan.scanId, [scan.files[0].id])
    await ready
    await expect(folders.scan(target.id)).rejects.toThrow('busy')
    await expect(folders.remove(target.id)).rejects.toThrow('busy')
    finish()
    expect((await moving).trashedIds).toHaveLength(1)
  })
})
