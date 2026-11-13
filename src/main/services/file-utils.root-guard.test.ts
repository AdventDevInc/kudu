import { describe, expect, it, vi } from 'vitest'

vi.mock('fs/promises', () => ({
  rm: vi.fn(),
  chmod: vi.fn(),
  rmdir: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  readdir: vi.fn(),
  open: vi.fn(),
  realpath: vi.fn()
}))
vi.mock('./settings-store', () => ({ getSettings: () => ({ cleaner: { secureDelete: true } }) }))
vi.mock('./scan-cache', () => ({ getCachedItems: () => [], removeCachedItems: vi.fn() }))
vi.mock('./deletion-log-store', () => ({ recordDeletions: vi.fn() }))
import { rm, open, readdir } from 'fs/promises'
import { safeDelete } from './file-utils'

describe('safeDelete root guard', () => {
  it.each(['D:', 'D:\\', 'D:/', 'D:\\folder\\..', '/', '\\\\server\\share'])(
    'blocks %s before overwrite or deletion',
    async (path) => {
      expect(await safeDelete(path)).toMatchObject({ success: false, reason: 'protected-path' })
      expect(rm).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
      expect(readdir).not.toHaveBeenCalled()
    }
  )
})
