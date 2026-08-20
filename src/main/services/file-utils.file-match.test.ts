import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./settings-store', () => ({
  getSettings: () => ({ cleaner: { secureDelete: false, skipRecentMinutes: 60 }, exclusions: [] }),
}))

vi.mock('./scan-cache', () => ({
  getCachedItems: () => [],
  removeCachedItems: () => {},
}))

import { scanAppRule, scanMatchingFiles } from './file-utils'

const tempRoots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kudu-file-match-'))
  tempRoots.push(root)
  return root
}

async function makeFile(filePath: string, ageDays: number): Promise<void> {
  await writeFile(filePath, 'cache-data')
  const modified = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
  await utimes(filePath, modified, modified)
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('scanMatchingFiles', () => {
  it('returns only allowlisted old files in matching immediate child directories', async () => {
    const root = await tempRoot()
    const staleUpdater = join(root, 'sample-updater')
    const freshUpdater = join(root, 'fresh-updater')
    const unrelated = join(root, 'not-an-update-cache')
    await Promise.all([staleUpdater, freshUpdater, unrelated].map((dir) => mkdir(dir)))

    const installer = join(staleUpdater, 'installer.exe')
    const blockmap = join(staleUpdater, 'current.blockmap')
    await makeFile(installer, 30)
    await makeFile(blockmap, 30)
    await makeFile(join(staleUpdater, 'state.json'), 30)
    await makeFile(join(freshUpdater, 'installer.exe'), 2)
    await makeFile(join(unrelated, 'installer.exe'), 30)

    const result = await scanMatchingFiles([root], {
      names: ['installer.exe', 'current.blockmap'],
      childDirSuffix: '-updater',
      minAgeDays: 14,
      skipIfChildExists: ['pending'],
    }, 'app', 'Updater Artifacts')

    expect(new Set(result.items.map((item) => item.path))).toEqual(new Set([installer, blockmap]))
    expect(result.itemCount).toBe(2)
    expect(result.totalSize).toBe(20)
  })

  it('skips the entire updater directory when pending state exists', async () => {
    const root = await tempRoot()
    const updater = join(root, 'sample-updater')
    await mkdir(join(updater, 'pending'), { recursive: true })
    await makeFile(join(updater, 'installer.exe'), 30)

    const result = await scanMatchingFiles([root], {
      names: ['installer.exe'],
      childDirSuffix: '-updater',
      minAgeDays: 14,
      skipIfChildExists: ['pending'],
    }, 'app', 'Updater Artifacts')

    expect(result.items).toEqual([])
  })

  it('does not follow matching child-directory links', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    await makeFile(join(outside, 'installer.exe'), 30)

    try {
      await symlink(outside, join(root, 'linked-updater'), 'junction')
    } catch {
      return // Symlink creation may be unavailable on locked-down Windows hosts.
    }

    const result = await scanMatchingFiles([root], {
      names: ['installer.exe'],
      childDirSuffix: '-updater',
      minAgeDays: 14,
    }, 'app', 'Updater Artifacts')

    expect(result.items).toEqual([])
  })
})

describe('scanAppRule', () => {
  it('applies a declarative UI group to scan results', async () => {
    const root = await tempRoot()
    await makeFile(join(root, 'old.log'), 30)

    const result = await scanAppRule({
      id: 'ai-logs',
      name: 'AI Logs',
      paths: [root],
      group: 'AI Tools',
      minAgeDays: 14,
    }, 'app')

    expect(result.group).toBe('AI Tools')
  })

  it('applies the configured age recursively and preserves recent files', async () => {
    const root = await tempRoot()
    const oldFile = join(root, 'old.log')
    const recentFile = join(root, 'recent.log')
    await makeFile(oldFile, 30)
    await makeFile(recentFile, 2)

    const result = await scanAppRule({
      id: 'settled-logs',
      name: 'Settled Logs',
      paths: [root],
      minAgeDays: 14,
    }, 'app')

    expect(result.items.map((item) => item.path)).toEqual([oldFile])
  })
})
