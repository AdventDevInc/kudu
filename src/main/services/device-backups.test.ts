import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { DeviceBackups } from './device-backups'

describe.skipIf(process.platform === 'win32')('local device backup cleanup', () => {
  let fixture: string
  let root: string
  let trash: string
  let service: DeviceBackups
  let now: number
  let failure: boolean
  let complete: boolean
  const folder = '1'.repeat(40)
  const second = '2'.repeat(40)

  async function backup(name: string) {
    const directory = join(root, name)
    await mkdir(directory)
    for (const file of ['Info.plist', 'Manifest.plist', 'Status.plist', 'data']) {
      const path = join(directory, file)
      await writeFile(path, 'fixture ' + file)
      const old = new Date(now - 120_000)
      await utimes(path, old, old)
    }
    return directory
  }

  beforeEach(async () => {
    fixture = await realpath(await mkdtemp(join(tmpdir(), 'kudu-device-backups-test-')))
    root = join(fixture, 'backups')
    trash = join(fixture, 'trash')
    await mkdir(root)
    await mkdir(trash)
    now = Date.now()
    failure = false
    complete = true
    service = new DeviceBackups(
      root,
      async (path) => {
        if (failure) throw new Error('Trash refused')
        await rename(path, join(trash, path.split('/').pop()!))
      },
      async (_path, key) =>
        key === 'Device Name' ? 'Fixture iPhone' : complete ? 'finished' : 'in progress',
      () => now
    )
  })
  afterEach(() => rm(fixture, { recursive: true, force: true }))

  it('moves only selected complete backups and preserves their contents', async () => {
    await backup(folder)
    await backup(second)
    const scan = await service.scan()
    expect(scan.items.every((item) => item.eligible)).toBe(true)
    const item = scan.items.find((item) => item.folder === folder)!
    const result = await service.remove(scan.scanId, [item.id], 'SUPPRIMER', true)
    expect(result.removedIds).toEqual([item.id])
    expect(await readFile(join(trash, folder, 'data'), 'utf8')).toBe('fixture data')
    expect((await lstat(join(root, second))).isDirectory()).toBe(true)
    await expect(service.remove(scan.scanId, [item.id], 'SUPPRIMER', true)).rejects.toThrow()
  })

  it('requires the current scan, selected IDs, typed confirmation and disconnected devices', async () => {
    await backup(folder)
    const scan = await service.scan()
    const id = scan.items[0].id
    await expect(service.remove(scan.scanId, [id], 'DELETE', false)).rejects.toThrow()
    await expect(service.remove(scan.scanId, [id], '', true)).rejects.toThrow()
    await expect(service.remove(scan.scanId, ['../outside'], 'DELETE', true)).rejects.toThrow()
    now += 11 * 60_000
    await expect(service.remove(scan.scanId, [id], 'DELETE', true)).rejects.toThrow('Analyze')
    expect((await lstat(join(root, folder))).isDirectory()).toBe(true)
  })

  it('skips backups changed after their scan', async () => {
    const directory = await backup(folder)
    const scan = await service.scan()
    await writeFile(join(directory, 'data'), 'changed')
    const result = await service.remove(scan.scanId, [scan.items[0].id], 'DELETE', true)
    expect(result.removedIds).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(await readFile(join(directory, 'data'), 'utf8')).toBe('changed')
  })

  it('retains a claimed backup and reports its recovery location when Trash fails', async () => {
    await backup(folder)
    const scan = await service.scan()
    failure = true
    const result = await service.remove(scan.scanId, [scan.items[0].id], 'DELETE', true)
    expect(result.removedIds).toEqual([])
    expect(result.recoveryPaths).toHaveLength(1)
    expect(await readFile(join(result.recoveryPaths[0], 'data'), 'utf8')).toBe('fixture data')
  })

  it('blocks incomplete, recent and linked backups', async () => {
    const directory = await backup(folder)
    complete = false
    expect((await service.scan()).items[0].eligible).toBe(false)
    complete = true
    await utimes(join(directory, 'data'), new Date(now), new Date(now))
    expect((await service.scan()).items[0].eligible).toBe(false)
    await rm(join(directory, 'data'))
    const outside = join(fixture, 'outside')
    await writeFile(outside, 'preserve')
    await symlink(outside, join(directory, 'data'))
    expect((await service.scan()).items[0].eligible).toBe(false)
    expect(await readFile(outside, 'utf8')).toBe('preserve')
  })

  it('rejects a replaced backup root', async () => {
    await backup(folder)
    const scan = await service.scan()
    await rename(root, root + '-moved')
    await mkdir(root)
    await expect(service.remove(scan.scanId, [scan.items[0].id], 'DELETE', true)).rejects.toThrow(
      'location changed'
    )
  })

  it('reports a missing root without creating one', async () => {
    await rm(root, { recursive: true })
    expect((await service.scan()).missing).toBe(true)
    await expect(lstat(root)).rejects.toThrow()
  })
})
