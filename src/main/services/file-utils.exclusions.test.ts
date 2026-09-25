import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./settings-store', () => ({
  getSettings: () => ({ cleaner: { secureDelete: false, skipRecentMinutes: 60 }, exclusions: [] })
}))
vi.mock('./scan-cache', () => ({ getCachedItems: () => [], removeCachedItems: () => {} }))

import { deletionTouchesExclusions } from './file-utils'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kudu-excl-'))
  mkdirSync(join(root, 'App', 'saves'), { recursive: true })
  writeFileSync(join(root, 'App', 'cache.bin'), 'x')
  writeFileSync(join(root, 'App', 'saves', 'slot1.sav'), 'x')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('deletionTouchesExclusions', () => {
  const app = () => join(root, 'App')

  it('is false with no exclusions', async () => {
    expect(await deletionTouchesExclusions(app(), [])).toBe(false)
  })

  it('is true when the target itself is excluded', async () => {
    expect(await deletionTouchesExclusions(app(), [app()])).toBe(true)
  })

  it('is true when the target sits inside an excluded folder', async () => {
    expect(await deletionTouchesExclusions(app(), [root])).toBe(true)
  })

  it('is true when an excluded path lies inside the target', async () => {
    expect(await deletionTouchesExclusions(app(), [join(app(), 'saves')])).toBe(true)
  })

  it('ignores exclusions that only share a name prefix', async () => {
    expect(await deletionTouchesExclusions(app(), [join(root, 'AppData')])).toBe(false)
    expect(await deletionTouchesExclusions(app(), [`${app()}Backup`])).toBe(false)
  })

  it('is true when a file inside matches an extension exclusion', async () => {
    expect(await deletionTouchesExclusions(app(), ['*.sav'])).toBe(true)
  })

  it('is false when no file inside matches the extension exclusion', async () => {
    expect(await deletionTouchesExclusions(app(), ['*.docx'])).toBe(false)
  })

  it('is false for a target that no longer exists', async () => {
    expect(await deletionTouchesExclusions(join(root, 'Gone'), ['*.sav'])).toBe(false)
  })
})

describe('deletionTouchesExclusions when the target cannot be inspected', () => {
  it('treats an unreadable target as affected', async () => {
    vi.resetModules()
    vi.doMock('fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs/promises')>()
      return {
        ...actual,
        lstat: async () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' })
        }
      }
    })
    const { deletionTouchesExclusions: check } = await import('./file-utils')
    expect(await check(join(root, 'App'), ['*.sav'])).toBe(true)
    vi.doUnmock('fs/promises')
    vi.resetModules()
  })
})

describe('deletionTouchesExclusions with untyped directory entries', () => {
  it('looks up entries whose type the filesystem did not report', async () => {
    vi.resetModules()
    vi.doMock('fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs/promises')>()
      return {
        ...actual,
        // Mimic a FUSE/network mount: every Dirent reports an unknown type.
        readdir: (async (path: string, opts?: { withFileTypes?: boolean }) => {
          const entries = await actual.readdir(path, { withFileTypes: true })
          if (!opts?.withFileTypes) return entries.map((e) => e.name)
          return entries.map((e) => ({
            name: e.name,
            isDirectory: () => false,
            isFile: () => false,
            isSymbolicLink: () => false
          }))
        }) as typeof actual.readdir
      }
    })
    const { deletionTouchesExclusions: check } = await import('./file-utils')
    expect(await check(join(root, 'App'), ['*.sav'])).toBe(true)
    vi.doUnmock('fs/promises')
    vi.resetModules()
  })
})
