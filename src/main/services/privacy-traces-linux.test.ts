import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./settings-store', () => ({
  getSettings: () => ({ cleaner: { secureDelete: false }, exclusions: [] })
}))
vi.mock('./deletion-log-store', () => ({ recordDeletions: () => {} }))

import {
  cleanPrivacyTraces,
  scanPrivacyTraces,
  type PrivacyTrace,
  type TraceScanContext
} from './privacy-traces'
import { findLinuxRecentFileTraces } from './privacy-traces-linux'

let home: string
let share: string
const ctx = (overrides: Partial<TraceScanContext> = {}): TraceScanContext => ({
  platform: 'linux',
  home,
  env: {},
  exclusions: [],
  ...overrides
})

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kudu-linux-traces-'))
  share = join(home, '.local', 'share')
  await mkdir(join(share, 'RecentDocuments'), { recursive: true })
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('findLinuxRecentFileTraces', () => {
  it('finds the GTK list and KDE entries and deletes only those', async () => {
    const xbel = join(share, 'recently-used.xbel')
    const kde = join(share, 'RecentDocuments', 'report.odt.desktop')
    const other = join(share, 'RecentDocuments', 'readme.txt')
    const nested = join(share, 'RecentDocuments', 'sub', 'deep.desktop')
    await writeFile(xbel, '<xbel/>')
    await writeFile(kde, '[Desktop Entry]')
    await writeFile(other, 'x')
    await mkdir(join(share, 'RecentDocuments', 'sub'))
    await writeFile(nested, '[Desktop Entry]')

    const cache = new Map<string, PrivacyTrace>()
    const results = await scanPrivacyTraces([findLinuxRecentFileTraces], ctx(), cache)
    expect(results.map((r) => [r.subcategory, r.items.map((i) => i.path)])).toEqual([
      ['Recent files (GNOME/GTK)', [xbel]],
      ['Recent documents (KDE)', [kde]]
    ])
    expect(results.flatMap((r) => r.items).every((i) => i.selected === false)).toBe(true)

    const ids = results.flatMap((r) => r.items.map((i) => i.id))
    const outcome = await cleanPrivacyTraces(ids, cache, { secureDelete: false, exclusions: [] })
    expect(outcome.filesDeleted).toBe(2)
    expect(existsSync(xbel)).toBe(false)
    expect(existsSync(kde)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(nested)).toBe(true)
  })

  it('ignores an empty GTK list', async () => {
    await writeFile(join(share, 'recently-used.xbel'), '')
    expect(await findLinuxRecentFileTraces(ctx())).toEqual([])
  })

  it('never lists symlinks', async () => {
    const target = join(home, 'target')
    await writeFile(target, 'keep')
    try {
      await symlink(target, join(share, 'recently-used.xbel'))
      await symlink(target, join(share, 'RecentDocuments', 'link.desktop'))
    } catch {
      return // symlinks unavailable (Windows without Developer Mode)
    }
    expect(await findLinuxRecentFileTraces(ctx())).toEqual([])
  })

  it('honours exclusions', async () => {
    await writeFile(join(share, 'recently-used.xbel'), '<xbel/>')
    await writeFile(join(share, 'RecentDocuments', 'a.desktop'), '[Desktop Entry]')
    const results = await scanPrivacyTraces(
      [findLinuxRecentFileTraces],
      ctx({ exclusions: [join(share, 'RecentDocuments')] }),
      new Map()
    )
    expect(results.map((r) => r.subcategory)).toEqual(['Recent files (GNOME/GTK)'])
  })

  it('does nothing on other platforms', async () => {
    await writeFile(join(share, 'recently-used.xbel'), '<xbel/>')
    expect(await findLinuxRecentFileTraces(ctx({ platform: 'darwin' }))).toEqual([])
  })
})
