import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve, sep } from 'path'
import { resolvePath } from '../rules/loader'
import type { AppCacheDef } from '../platform/types'

vi.mock('./settings-store', () => ({
  getSettings: () => ({ cleaner: { secureDelete: false, skipRecentMinutes: 60 }, exclusions: [] })
}))
vi.mock('./scan-cache', () => ({ getCachedItems: () => [], removeCachedItems: () => {} }))

import { scanAppRule } from './file-utils'

const rules = JSON.parse(readFileSync(resolve(__dirname, '../../../rules/win32/apps.json'), 'utf8'))
  .apps as AppCacheDef[]
const roots: string[] = []
const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kudu-app-cache-'))
  roots.push(root)
  return root
}

function rule(id: string, root: string): AppCacheDef {
  const source = rules.find((entry) => entry.id === id)
  if (!source) throw new Error(`Missing rule: ${id}`)
  return {
    ...source,
    paths: source.paths.map((path) =>
      // Use native fixture paths so the real Windows rules are exercised on every CI OS.
      resolvePath(
        path,
        { APPDATA: join(root, 'Roaming'), LOCALAPPDATA: join(root, 'Local') },
        'linux'
      )
    )
  }
}

async function file(path: string, recent = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'fixture content')
  if (!recent) await utimes(path, old, old)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Windows app cache coverage', () => {
  it.each([
    ['t3-code', 't3code'],
    ['t3-code', 't3code-v2'],
    ['pinokio', 'Pinokio'],
    ['granola', 'Granola'],
    ['wsl-cleaner', 'wsl-cleaner']
  ])(
    '%s scans settled HTTP entries in %s while preserving recent and user data',
    async (id, app) => {
      const root = await fixture()
      const profile = join(root, 'Roaming', app)
      const settled = join(profile, 'Cache', 'Cache_Data', 'settled')
      const recent = join(profile, 'Cache', 'Cache_Data', 'nested', 'active')
      await file(settled)
      await file(recent, true)
      // An old containing directory must never make a recent descendant eligible.
      await utimes(dirname(recent), old, old)
      for (const protectedPath of [
        'Local Storage/Cache/user-data',
        'IndexedDB/database',
        'Network/Cookies',
        'Sessions/session',
        'Service Worker/CacheStorage/offline',
        'api/installed-app/model.bin',
        'cache-v6.json.enc',
        'granola.db',
        'stored-accounts.json.enc',
        'preferences.json',
        'history.json',
        'disk.vhdx'
      ])
        await file(join(profile, protectedPath))

      const result = await scanAppRule(rule(id, root), 'app')
      expect(result.items.map((item) => item.path)).toEqual([settled])
      expect(result.items[0].selected).toBe(true)
      expect(result.items[0].cacheReset).toBeUndefined()
    }
  )

  it.each(['t3-code', 'spark-desktop', 'pinokio', 'granola', 'wsl-cleaner'])(
    '%s performance caches require local opt-in and retain recent entries',
    async (id) => {
      const root = await fixture()
      const appRule = rule(`${id}-performance-cache`, root)
      const settled = [] as string[]
      for (const path of appRule.paths) {
        const entry = join(path, 'settled')
        settled.push(entry)
        await file(entry)
        await file(join(path, 'recent'), true)
      }
      const result = await scanAppRule(appRule, 'app')
      expect(result.items.map((item) => item.path).sort()).toEqual(settled.sort())
      expect(result.group).toContain('Optional cache resets')
      expect(result.items.every((item) => item.cacheReset && !item.selected)).toBe(true)
    }
  )

  it('never targets Spark HTTP cache or offline mail and attachment stores', async () => {
    const root = await fixture()
    const profile = join(root, 'Local', 'Spark Desktop')
    for (const protectedPath of [
      'Cache/Cache_Data/attachment',
      'core-data/mail.db',
      'core-tmp/attachment',
      'storage/offline-mail',
      'transcription-data/transcript',
      'IndexedDB/database',
      'Network/Cookies'
    ])
      await file(join(profile, protectedPath))
    const appRules = rules.filter((entry) => entry.id.startsWith('spark-desktop'))
    expect(appRules.length).toBeGreaterThan(0)
    for (const appRule of appRules) {
      expect((await scanAppRule(rule(appRule.id, root), 'app')).items).toEqual([])
    }
  })

  it.each(['t3code', 't3code-v2'])(
    'separates %s partition HTTP caches from optional resets and excludes stored user data',
    async (profile) => {
      const root = await fixture()
      const partition = join(root, 'Roaming', profile, 'Partitions', 't3code-preview-example')
      await file(join(partition, 'Cache', 'Cache_Data', 'settled'))
      await file(join(partition, 'GPUCache', 'settled'))
      for (const ancestor of [
        'Local Storage',
        'IndexedDB',
        'Service Worker',
        'Network',
        'Sessions'
      ]) {
        await file(join(partition, ancestor, 'Cache', 'content'))
        await file(join(partition, ancestor, 'GPUCache', 'content'))
      }
      const ordinary = await scanAppRule(rule('t3-code-partitions', root), 'app')
      const optional = await scanAppRule(rule('t3-code-partitions-performance-cache', root), 'app')
      expect(ordinary.items).toHaveLength(1)
      expect(optional.items).toHaveLength(1)
      expect(ordinary.items[0].path.startsWith(join(partition, 'Cache') + sep)).toBe(true)
      expect(optional.items[0].path).toBe(join(partition, 'GPUCache', 'settled'))
      expect(optional.items[0].selected).toBe(false)
      expect(optional.items[0].cacheReset).toBe(true)
      expect(ordinary.items[0].selected).toBe(true)
    }
  )
})
