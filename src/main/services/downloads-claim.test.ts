import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
  link,
  utimes
} from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { DownloadsClaimBatch } from './downloads-claim'

describe('atomic Downloads claims', () => {
  let root: string, original: string
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'kudu-downloads-claim-')))
    original = join(root, 'setup.exe')
    await writeFile(original, 'selected file')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const consume = async (path: string) => {
    await unlink(path)
  }

  it('rejects a hard link created during the atomic claim and preserves both names', async () => {
    const expected = await lstat(original, { bigint: true })
    const retained = join(root, 'retained.exe')
    const trash = vi.fn(consume)
    const operations = {
      link,
      rename: async (source: string, destination: string) => {
        await link(source, retained)
        await rename(source, destination)
      }
    }
    const batch = new DownloadsClaimBatch(root, async () => true, trash, undefined, operations)
    expect(await batch.move(original, expected)).toEqual({ trashed: false })
    await batch.finish()
    expect(trash).not.toHaveBeenCalled()
    expect(await readFile(original, 'utf8')).toBe('selected file')
    expect(await readFile(retained, 'utf8')).toBe('selected file')
  })

  it('claims the chosen inode and leaves a replacement at its old name untouched during trash', async () => {
    const expected = await lstat(original, { bigint: true })
    let staged = ''
    const trash = vi.fn(async (path: string) => {
      staged = path
      expect(path).not.toBe(original)
      expect(basename(path)).toBe('setup.exe')
      expect(await readFile(path, 'utf8')).toBe('selected file')
      await writeFile(original, 'new unselected download')
      await consume(path)
    })
    const batch = new DownloadsClaimBatch(root, async () => true, trash)
    expect(await batch.move(original, expected)).toEqual({ trashed: true })
    await batch.finish()
    expect(await readFile(original, 'utf8')).toBe('new unselected download')
    expect((await lstat(dirname(staged))).isDirectory()).toBe(true)
    expect(await readdir(dirname(staged))).toEqual([])
  })

  it('restores a replacement that wins immediately before rename without trashing it', async () => {
    const expected = await lstat(original, { bigint: true })
    const trash = vi.fn(consume)
    const operations = {
      link,
      rename: async (source: string, destination: string) => {
        await rename(source, join(root, 'original-retained.exe'))
        await writeFile(source, 'replacement')
        await rename(source, destination)
      }
    }
    const batch = new DownloadsClaimBatch(root, async () => true, trash, undefined, operations)
    expect(await batch.move(original, expected)).toEqual({ trashed: false })
    await batch.finish()
    expect(trash).not.toHaveBeenCalled()
    expect(await readFile(original, 'utf8')).toBe('replacement')
    expect(await readFile(join(root, 'original-retained.exe'), 'utf8')).toBe('selected file')
    expect(
      (await readdir(root)).filter((name) => name.startsWith('Kudu Downloads Recovery-'))
    ).toEqual([])
  })

  it('preserves both files and reports recovery when the original name becomes occupied', async () => {
    const expected = await lstat(original, { bigint: true })
    const trash = vi.fn(async () => {
      await writeFile(original, 'new unselected file')
      throw new Error('trash failed')
    })
    const batch = new DownloadsClaimBatch(root, async () => true, trash)
    const result = await batch.move(original, expected)
    await batch.finish()
    expect(result.trashed).toBe(false)
    expect(result.recoveryPath).toBeTruthy()
    expect(await readFile(result.recoveryPath!, 'utf8')).toBe('selected file')
    expect(await readFile(original, 'utf8')).toBe('new unselected file')
  })

  it('restores the original name after native trash failure using a no-clobber hard link', async () => {
    const expected = await lstat(original, { bigint: true })
    const trash = vi.fn(async () => {
      throw new Error('locked')
    })
    const batch = new DownloadsClaimBatch(root, async () => true, trash)
    expect(await batch.move(original, expected)).toEqual({ trashed: false })
    await batch.finish()
    expect(await readFile(original, 'utf8')).toBe('selected file')
    expect(await readdir(root)).toEqual(['setup.exe'])
  })

  it('keeps a recoverable file if hard links are unsupported instead of overwriting or deleting it', async () => {
    const expected = await lstat(original, { bigint: true })
    const operations = {
      rename,
      link: async () => {
        throw new Error('ENOTSUP')
      }
    }
    const batch = new DownloadsClaimBatch(
      root,
      async () => true,
      async () => {
        throw new Error('locked')
      },
      undefined,
      operations
    )
    const result = await batch.move(original, expected)
    await batch.finish()
    expect(await readFile(result.recoveryPath!, 'utf8')).toBe('selected file')
    await expect(lstat(original)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not trash a newly excluded claimed file and restores it', async () => {
    const expected = await lstat(original, { bigint: true })
    const trash = vi.fn(consume)
    const allowed = vi.fn(async () => false)
    const batch = new DownloadsClaimBatch(root, async () => true, trash, allowed)
    expect(await batch.move(original, expected)).toEqual({ trashed: false })
    await batch.finish()
    expect(allowed).toHaveBeenCalledWith(
      original,
      expect.stringContaining('Kudu Downloads Recovery-')
    )
    expect(trash).not.toHaveBeenCalled()
    expect(await readFile(original, 'utf8')).toBe('selected file')
  })

  it('rejects a replacement with identical size and mtime using inode identity', async () => {
    const expected = await lstat(original, { bigint: true })
    const trash = vi.fn(consume)
    const operations = {
      link,
      rename: async (source: string, destination: string) => {
        await rename(source, join(root, 'retained.exe'))
        await writeFile(source, 'replacement!!')
        await utimes(source, Number(expected.atimeMs) / 1000, Number(expected.mtimeMs) / 1000)
        await rename(source, destination)
      }
    }
    const batch = new DownloadsClaimBatch(root, async () => true, trash, undefined, operations)
    expect((await batch.move(original, expected)).trashed).toBe(false)
    expect(trash).not.toHaveBeenCalled()
    expect(await readFile(original, 'utf8')).toBe('replacement!!')
  })

  it('preserves an unexpected directory claimed during the race, never recursively deleting it', async () => {
    const expected = await lstat(original, { bigint: true })
    const trash = vi.fn(consume)
    const operations = {
      link,
      rename: async (source: string, destination: string) => {
        await rename(source, join(root, 'retained.exe'))
        await mkdir(source)
        await writeFile(join(source, 'important.txt'), 'keep')
        await rename(source, destination)
      }
    }
    const batch = new DownloadsClaimBatch(root, async () => true, trash, undefined, operations)
    const result = await batch.move(original, expected)
    await batch.finish()
    expect(trash).not.toHaveBeenCalled()
    expect(await readFile(join(result.recoveryPath!, 'important.txt'), 'utf8')).toBe('keep')
  })

  it('reports no phantom recovery path when the claim rename fails', async () => {
    const expected = await lstat(original, { bigint: true })
    const operations = {
      link,
      rename: async () => {
        throw new Error('busy')
      }
    }
    const batch = new DownloadsClaimBatch(root, async () => true, consume, undefined, operations)
    expect(await batch.move(original, expected)).toEqual({ trashed: false })
    await batch.finish()
    expect(await readdir(root)).toEqual(['setup.exe'])
  })

  it('preserves the claim and never trashes it if Downloads validation fails after rename', async () => {
    const expected = await lstat(original, { bigint: true })
    let unchanged = true
    const trash = vi.fn(consume)
    const operations = {
      link,
      rename: async (source: string, destination: string) => {
        await rename(source, destination)
        unchanged = false
      }
    }
    const batch = new DownloadsClaimBatch(root, async () => unchanged, trash, undefined, operations)
    const result = await batch.move(original, expected)
    await batch.finish()
    expect(trash).not.toHaveBeenCalled()
    expect(result.trashed).toBe(false)
    expect(await readFile(result.recoveryPath!, 'utf8')).toBe('selected file')
    await expect(lstat(original)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses one retained recovery directory for multiple successful claims', async () => {
    const second = join(root, 'archive.zip')
    await writeFile(second, 'archive')
    const firstIdentity = await lstat(original, { bigint: true }),
      secondIdentity = await lstat(second, { bigint: true })
    const trash = vi.fn(consume)
    const batch = new DownloadsClaimBatch(root, async () => true, trash)
    expect((await batch.move(original, firstIdentity)).trashed).toBe(true)
    expect((await batch.move(second, secondIdentity)).trashed).toBe(true)
    await batch.finish()
    expect(dirname(trash.mock.calls[0][0])).toBe(dirname(trash.mock.calls[1][0]))
    expect(await readdir(root)).toHaveLength(1)
  })
})
