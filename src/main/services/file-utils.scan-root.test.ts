import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./settings-store', () => ({
  getSettings: () => ({ cleaner: { secureDelete: false, skipRecentMinutes: 60 }, exclusions: [] })
}))
vi.mock('./scan-cache', () => ({ getCachedItems: () => [], removeCachedItems: () => {} }))

import { expandExclusions, isExcludedResolved, resolveScanRoot } from './file-utils'

// An alias (symlink, or a junction on Windows — creatable without elevation)
// pointing into an excluded tree must not let a scan or delete slip past it.
let base: string
let privateDir: string
let alias: string
beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'kudu-scanroot-')))
  privateDir = join(base, 'private')
  mkdirSync(privateDir)
  writeFileSync(join(privateDir, 'secret.bin'), 'x')
  alias = join(base, 'alias')
  symlinkSync(privateDir, alias, 'junction')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('resolveScanRoot', () => {
  it('returns the real path of the chosen folder', async () => {
    expect(await resolveScanRoot(alias, [])).toBe(realpathSync.native(privateDir))
  })

  it('refuses an alias whose target is excluded', async () => {
    expect(await resolveScanRoot(alias, [privateDir])).toBeNull()
  })

  it('refuses a folder that is excluded by the name it was chosen by', async () => {
    expect(await resolveScanRoot(alias, [alias])).toBeNull()
  })

  it('returns null for a folder that does not exist', async () => {
    expect(await resolveScanRoot(join(base, 'missing'), [])).toBeNull()
  })
})

describe('expandExclusions', () => {
  it('adds the real location of path exclusions reached through an alias', async () => {
    const expanded = await expandExclusions([alias, '*.log', join(base, 'missing')])
    expect(expanded).toEqual(
      expect.arrayContaining([
        alias,
        '*.log',
        join(base, 'missing'),
        realpathSync.native(privateDir)
      ])
    )
    expect(await resolveScanRoot(privateDir, expanded)).toBeNull()
  })
})

describe('expandExclusions with a missing tail', () => {
  it('resolves the existing prefix of an exclusion that does not exist yet', async () => {
    const reserved = join(alias, 'empty', 'reserved')
    const expanded = await expandExclusions([reserved])
    expect(expanded).toContain(join(realpathSync.native(privateDir), 'empty', 'reserved'))
  })
})

describe('isExcludedResolved', () => {
  it('catches a file reached through an alias into an excluded folder', async () => {
    expect(await isExcludedResolved(join(alias, 'secret.bin'), [privateDir])).toBe(true)
  })

  it('still honours plain path and extension exclusions', async () => {
    expect(await isExcludedResolved(join(privateDir, 'secret.bin'), ['*.bin'])).toBe(true)
    expect(await isExcludedResolved(join(privateDir, 'secret.bin'), [join(base, 'other')])).toBe(
      false
    )
  })
})
