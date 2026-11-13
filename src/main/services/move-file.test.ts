import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// rename() only fails with EXDEV when the two paths are on different mounts,
// which a test can't set up portably. Make it fail on demand instead.
const renameFailure = vi.hoisted(() => ({ code: null as string | null }))
const copyHooks = vi.hoisted(() => ({ afterCopy: null as (() => Promise<void>) | null }))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      await actual.copyFile(...args)
      await copyHooks.afterCopy?.()
    },
    rename: async (src: string, dest: string) => {
      if (renameFailure.code) {
        const err = new Error(`${renameFailure.code}: simulated`) as NodeJS.ErrnoException
        err.code = renameFailure.code
        throw err
      }
      return actual.rename(src, dest)
    }
  }
})

import { moveFile } from './move-file'

describe('moveFile', () => {
  let dir: string

  beforeEach(async () => {
    renameFailure.code = null
    copyHooks.afterCopy = null
    dir = await mkdtemp(join(tmpdir(), 'kudu-move-file-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('moves a file on the same filesystem', async () => {
    const src = join(dir, 'a.bin')
    const dest = join(dir, 'b.bin')
    await writeFile(src, 'payload')

    await moveFile(src, dest)

    expect(existsSync(src)).toBe(false)
    expect(await readFile(dest, 'utf8')).toBe('payload')
  })

  it('copies and removes the source when rename fails with EXDEV', async () => {
    const src = join(dir, 'a.bin')
    const dest = join(dir, 'b.bin')
    await writeFile(src, 'payload')
    const mtime = new Date('2024-01-02T03:04:05Z')
    await utimes(src, mtime, mtime)
    renameFailure.code = 'EXDEV'

    await moveFile(src, dest)

    expect(existsSync(src)).toBe(false)
    expect(await readFile(dest, 'utf8')).toBe('payload')
    expect((await stat(dest)).mtime.getTime()).toBe(mtime.getTime())
  })

  it('does not overwrite an existing destination when copying across filesystems', async () => {
    const src = join(dir, 'a.bin')
    const dest = join(dir, 'b.bin')
    await writeFile(src, 'quarantined')
    await writeFile(dest, 'newer file')
    renameFailure.code = 'EXDEV'

    await expect(moveFile(src, dest)).rejects.toMatchObject({ code: 'EEXIST' })

    expect(await readFile(src, 'utf8')).toBe('quarantined')
    expect(await readFile(dest, 'utf8')).toBe('newer file')
  })

  it('preserves a replacement source and removes the stale copy', async () => {
    const src = join(dir, 'a.bin')
    const dest = join(dir, 'b.bin')
    const replacement = join(dir, 'replacement.bin')
    await writeFile(src, 'original detection')
    await writeFile(replacement, 'replacement user data')
    renameFailure.code = 'EXDEV'
    copyHooks.afterCopy = async () => {
      // Use the real rename to replace the source after its contents were copied.
      renameFailure.code = null
      await rename(src, join(dir, 'old.bin'))
      await rename(replacement, src)
    }

    await expect(moveFile(src, dest)).rejects.toThrow(/source changed/)

    expect(await readFile(src, 'utf8')).toBe('replacement user data')
    expect(existsSync(dest)).toBe(false)
  })

  it('preserves edits to the source made during the copy', async () => {
    const src = join(dir, 'a.bin')
    const dest = join(dir, 'b.bin')
    await writeFile(src, 'original')
    renameFailure.code = 'EXDEV'
    copyHooks.afterCopy = async () => {
      await writeFile(src, 'new user data written during copying')
    }

    await expect(moveFile(src, dest)).rejects.toThrow(/source changed/)

    expect(await readFile(src, 'utf8')).toBe('new user data written during copying')
    expect(existsSync(dest)).toBe(false)
  })

  it('rethrows other rename errors without copying', async () => {
    const src = join(dir, 'a.bin')
    const dest = join(dir, 'b.bin')
    await writeFile(src, 'payload')
    renameFailure.code = 'EACCES'

    await expect(moveFile(src, dest)).rejects.toMatchObject({ code: 'EACCES' })

    expect(existsSync(src)).toBe(true)
    expect(existsSync(dest)).toBe(false)
  })

  // Creating symlinks needs Developer Mode or admin rights on Windows.
  it.skipIf(process.platform === 'win32')(
    'refuses to copy a symlink across filesystems',
    async () => {
      const target = join(dir, 'target.bin')
      const src = join(dir, 'link.bin')
      const dest = join(dir, 'b.bin')
      await writeFile(target, 'payload')
      await symlink(target, src)
      renameFailure.code = 'EXDEV'

      await expect(moveFile(src, dest)).rejects.toThrow(/not a regular file/)

      expect(existsSync(src)).toBe(true)
      expect(existsSync(dest)).toBe(false)
    }
  )
})
