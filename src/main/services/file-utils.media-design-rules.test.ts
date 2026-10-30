import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, normalize, resolve, sep } from 'path'
import type { AppCacheDef } from '../platform/types'

const state = vi.hoisted(() => ({ exclusions: [] as string[] }))
vi.mock('./settings-store', () => ({
  getSettings: () => ({
    cleaner: { secureDelete: false, skipRecentMinutes: 60 },
    exclusions: state.exclusions
  })
}))
vi.mock('./scan-cache', () => ({ getCachedItems: () => [], removeCachedItems: () => {} }))

import { scanAppRule } from './file-utils'

type Platform = 'win32' | 'darwin' | 'linux'
const platforms: Platform[] = ['win32', 'darwin', 'linux']
let root: string
let variables: Record<string, string>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kudu-media-rules-'))
  state.exclusions = []
  variables = {
    HOME: root,
    CACHE: join(root, '.cache'),
    CONFIG: join(root, '.config'),
    LOCAL_SHARE: join(root, '.local', 'share'),
    APPDATA: join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'AppData', 'Local'),
    LIBRARY: join(root, 'Library'),
    CACHES: join(root, 'Library', 'Caches'),
    APP_SUPPORT: join(root, 'Library', 'Application Support')
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function rules(platform: Platform): Promise<AppCacheDef[]> {
  const source = await readFile(resolve('rules', platform, 'apps.json'), 'utf8')
  return JSON.parse(source).apps
}

async function rule(platform: Platform, id: string): Promise<AppCacheDef> {
  const app = (await rules(platform)).find((entry) => entry.id === id)
  if (!app) throw new Error(`Missing ${platform} rule: ${id}`)
  return {
    ...app,
    paths: app.paths.map((path) =>
      normalize(
        path.replace(/\$\{([A-Z_]+)\}/g, (_, name) => {
          if (!variables[name]) throw new Error(`Unknown variable: ${name}`)
          return variables[name]
        })
      )
    )
  }
}

async function file(path: string, ageDays = 30): Promise<string> {
  if (!resolve(path).startsWith(resolve(root) + sep)) throw new Error('Fixture escaped its root')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.alloc(4096))
  const modified = new Date(Date.now() - ageDays * 86400000)
  await utimes(path, modified, modified)
  return path
}

describe.each(platforms)('%s media and design cleaner rules', (platform) => {
  it('scans DaVinci Resolve logs while preserving project libraries', async () => {
    const app = await rule(platform, 'davinci-resolve')
    const supportBase =
      platform === 'win32'
        ? join(variables.APPDATA, 'Blackmagic Design', 'DaVinci Resolve', 'Support')
        : platform === 'darwin'
          ? join(variables.APP_SUPPORT, 'Blackmagic Design', 'DaVinci Resolve')
          : join(variables.LOCAL_SHARE, 'DaVinciResolve')

    // Protected project database
    await file(join(supportBase, 'Resolve Project Library', 'Project.db'))

    // Logs and crash dumps
    const oldLog = await file(join(supportBase, 'logs', 'davinci.log'), 10)
    const oldDump = await file(join(supportBase, 'CrashDumps', 'crash.dmp'), 10)
    await file(join(supportBase, 'logs', 'active.log'), 0) // recent log

    const result = await scanAppRule(app, 'app')
    const scannedPaths = result.items.map((i) => i.path).sort()
    expect(scannedPaths).toContain(oldLog)
    expect(scannedPaths).toContain(oldDump)
    expect(scannedPaths.some((p) => p.includes('Project.db'))).toBe(false)
  })

  if (platform !== 'linux') {
    it('scans CapCut cache and logs while preserving project drafts', async () => {
      const app = await rule(platform, 'capcut')
      const capcutBase =
        platform === 'win32'
          ? join(variables.LOCALAPPDATA, 'CapCut', 'User Data')
          : join(variables.APP_SUPPORT, 'CapCut')

      // Protected draft project
      await file(join(capcutBase, 'Projects', 'draft_001', 'draft_content.json'))

      // Cache and log files
      const oldCache =
        platform === 'win32'
          ? await file(join(capcutBase, 'Cache', 'proxy_01.mp4'), 10)
          : await file(join(variables.CACHES, 'CapCut', 'cache_data.bin'), 10)
      const oldLog = await file(join(capcutBase, 'Log', 'app.log'), 10)
      await file(join(capcutBase, 'Log', 'recent.log'), 0) // recent

      const result = await scanAppRule(app, 'app')
      const scannedPaths = result.items.map((i) => i.path).sort()
      expect(scannedPaths).toContain(oldCache)
      expect(scannedPaths).toContain(oldLog)
      expect(scannedPaths.some((p) => p.includes('draft_content.json'))).toBe(false)
    })

    it('scans Adobe Camera Raw cache and old logs', async () => {
      const rawApp = await rule(platform, 'adobe-cameraraw')
      const rawCache =
        platform === 'win32'
          ? await file(join(variables.LOCALAPPDATA, 'Adobe', 'CameraRaw', 'Cache2', 'entry.dat'), 10)
          : await file(join(variables.CACHES, 'Adobe', 'CameraRaw', 'Cache2', 'entry.dat'), 10)

      const rawResult = await scanAppRule(rawApp, 'app')
      expect(rawResult.items.map((i) => i.path)).toContain(rawCache)

      const logApp = await rule(platform, 'adobe-logs')
      const logFile =
        platform === 'win32'
          ? await file(join(variables.APPDATA, 'Adobe', 'Logs', 'Photoshop.log'), 14)
          : await file(join(variables.LIBRARY, 'Logs', 'Adobe', 'Photoshop.log'), 14)

      // Recent log should be skipped (< 7 days)
      const recentLog =
        platform === 'win32'
          ? await file(join(variables.APPDATA, 'Adobe', 'Logs', 'Recent.log'), 2)
          : await file(join(variables.LIBRARY, 'Logs', 'Adobe', 'Recent.log'), 2)

      const logResult = await scanAppRule(logApp, 'app')
      expect(logResult.items.map((i) => i.path)).toContain(logFile)
      expect(logResult.items.map((i) => i.path)).not.toContain(recentLog)
    })
  }
})
