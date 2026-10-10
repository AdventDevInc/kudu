import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  rename,
  link,
  symlink,
  realpath,
  unlink,
  readFile
} from 'fs/promises'
import { basename, dirname } from 'path'
import { tmpdir } from 'os'
import { join } from 'path'
import { DownloadsReview } from './downloads-review'

describe('DownloadsReview filesystem safety', () => {
  let fixture: string, root: string, configured: string, exclusions: string[]
  let trash: ReturnType<typeof vi.fn>, reveal: ReturnType<typeof vi.fn>, review: DownloadsReview
  beforeEach(async () => {
    fixture = await realpath(await mkdtemp(join(tmpdir(), 'kudu-downloads-')))
    root = join(fixture, 'Downloads')
    await mkdir(root)
    configured = root
    exclusions = []
    trash = vi.fn(async (path: string) => {
      await unlink(path)
    })
    reveal = vi.fn()
    review = new DownloadsReview(
      () => configured,
      async () => exclusions,
      trash,
      reveal
    )
  })
  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true })
  })

  it('reviews top-level files only, classifies candidates and skips partial/hidden/excluded entries', async () => {
    for (const name of [
      'setup.msi',
      'backup.zip',
      'image.dmg',
      'notes.pdf',
      'video.crdownload',
      '.private',
      'skip.exe'
    ])
      await writeFile(join(root, name), 'data')
    await mkdir(join(root, 'folder'))
    await writeFile(join(root, 'folder', 'nested.zip'), 'data')
    exclusions = [join(root, 'skip.exe')]
    const result = await review.scan()
    expect(result.files.map((file) => [file.name, file.kind]).sort()).toEqual([
      ['backup.zip', 'archive'],
      ['image.dmg', 'diskImage'],
      ['notes.pdf', 'other'],
      ['setup.msi', 'installer']
    ])
    expect(result.skipped).toBe(4)
    expect(trash).not.toHaveBeenCalled()
  })
  it('accepts only session-bound opaque IDs, deduplicates IDs and expires previous scans', async () => {
    await writeFile(join(root, 'setup.exe'), 'data')
    const old = await review.scan(),
      current = await review.scan()
    expect((await review.trashSelected(old.scanId, [old.files[0].id])).skippedIds).toHaveLength(1)
    const id = current.files[0].id
    const result = await review.trashSelected(current.scanId, [
      id,
      id,
      join(root, 'setup.exe'),
      '../outside'
    ])
    expect(result.trashedIds).toEqual([id])
    expect(result.skippedIds).toHaveLength(2)
    expect(trash).toHaveBeenCalledOnce()
    expect(basename(trash.mock.calls[0][0])).toBe('setup.exe')
    expect(dirname(trash.mock.calls[0][0])).not.toBe(root)
  })
  it('skips content modifications, replacements and exclusions added after scanning', async () => {
    for (const name of ['changed.zip', 'replaced.zip', 'excluded.zip'])
      await writeFile(join(root, name), 'data')
    const result = await review.scan()
    await writeFile(join(root, 'changed.zip'), 'new data')
    await rename(join(root, 'replaced.zip'), join(root, 'old.zip'))
    await writeFile(join(root, 'replaced.zip'), 'data')
    exclusions = [join(root, 'excluded.zip')]
    const moved = await review.trashSelected(
      result.scanId,
      result.files.map((file) => file.id)
    )
    expect(moved.skippedIds).toHaveLength(3)
    expect(trash).not.toHaveBeenCalled()
  })
  it('skips a replaced root or a redirected native Downloads configuration', async () => {
    await writeFile(join(root, 'setup.exe'), 'data')
    const result = await review.scan()
    const other = join(fixture, 'other')
    await mkdir(other)
    configured = other
    expect(
      (await review.trashSelected(result.scanId, [result.files[0].id])).skippedIds
    ).toHaveLength(1)
    configured = root
    await rename(root, join(fixture, 'old-downloads'))
    await mkdir(root)
    await writeFile(join(root, 'setup.exe'), 'data')
    expect(
      (await review.trashSelected(result.scanId, [result.files[0].id])).skippedIds
    ).toHaveLength(1)
    expect(trash).not.toHaveBeenCalled()
  })
  it('does not traverse a parent replaced by a junction or symlink', async () => {
    await writeFile(join(root, 'setup.exe'), 'data')
    const result = await review.scan()
    const previous = join(fixture, 'previous')
    await rename(root, previous)
    await symlink(previous, root, process.platform === 'win32' ? 'junction' : 'dir')
    expect(
      (await review.trashSelected(result.scanId, [result.files[0].id])).skippedIds
    ).toHaveLength(1)
    expect(trash).not.toHaveBeenCalled()
  })
  it('allows OS-configured redirected Downloads while preserving its canonical identity', async () => {
    const redirected = join(fixture, 'redirected')
    await mkdir(redirected)
    await writeFile(join(redirected, 'setup.exe'), 'data')
    await rm(root, { recursive: true })
    await symlink(redirected, root, process.platform === 'win32' ? 'junction' : 'dir')
    const result = await review.scan()
    expect(result.directory).toBe(redirected)
    await review.openLocation(result.scanId, result.files[0].id)
    expect(reveal).toHaveBeenCalledExactlyOnceWith(join(redirected, 'setup.exe'))
  })
  it('moves only the selected hard link, never its other name', async () => {
    await writeFile(join(root, 'one.zip'), 'data')
    await link(join(root, 'one.zip'), join(root, 'two.zip'))
    const result = await review.scan()
    const selected = result.files.find((file) => file.name === 'one.zip')!
    await review.trashSelected(result.scanId, [selected.id])
    expect(trash).toHaveBeenCalledOnce()
    expect(basename(trash.mock.calls[0][0])).toBe('one.zip')
    expect(await readFile(join(root, 'two.zip'), 'utf8')).toBe('data')
  })
  it('serializes scan and trash and safely reports failed native trash', async () => {
    await writeFile(join(root, 'setup.exe'), 'data')
    const result = await review.scan()
    let release!: () => void
    trash.mockImplementationOnce(
      (path: string) =>
        new Promise<void>((resolve) => {
          release = () => {
            void unlink(path).then(resolve)
          }
        })
    )
    const moving = review.trashSelected(result.scanId, [result.files[0].id])
    await vi.waitFor(() => expect(trash).toHaveBeenCalledOnce())
    await expect(review.scan()).rejects.toThrow('busy')
    await expect(review.trashSelected(result.scanId, [result.files[0].id])).rejects.toThrow('busy')
    release()
    await moving
    await writeFile(join(root, 'setup.exe'), 'new data')
    const fresh = await review.scan()
    trash.mockRejectedValueOnce(new Error('locked'))
    expect((await review.trashSelected(fresh.scanId, [fresh.files[0].id])).skippedIds).toHaveLength(
      1
    )
  })
  it('reports missing Downloads and rejects malformed selections', async () => {
    await rm(root, { recursive: true })
    await expect(review.scan()).rejects.toThrow()
    await expect(review.trashSelected('scan', null as unknown as string[])).rejects.toThrow(
      'Invalid selection'
    )
  })
})
