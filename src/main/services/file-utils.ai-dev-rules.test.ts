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
  root = await mkdtemp(join(tmpdir(), 'kudu-ai-dev-rules-'))
  state.exclusions = []
  variables = {
    HOME: root,
    CACHE: join(root, '.cache'),
    CONFIG: join(root, '.config'),
    APPDATA: join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'AppData', 'Local'),
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

// Exercise each platform's actual bundled targets on the host filesystem.
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

describe.each(platforms)('%s AI and developer cleaner rules', (platform) => {
  it('preserves LM Studio models, conversations, settings, and recent logs', async () => {
    const logs: string[] = []
    for (const home of [join(root, '.cache', 'lm-studio'), join(root, '.lmstudio')]) {
      for (const content of [
        'models/publisher/model/model.gguf',
        'conversations/chat.json',
        'settings.json',
        '.internal/state.json'
      ]) {
        await file(join(home, content))
      }
      logs.push(await file(join(home, 'server-logs', 'old.log')))
      await file(join(home, 'server-logs', 'recent.log'), 0)
    }

    const result = await scanAppRule(await rule(platform, 'lm-studio'), 'app')
    expect(result.items.map((item) => item.path).sort()).toEqual(logs.sort())
    expect(result.items.every((item) => item.selected)).toBe(true)
  })

  it('preserves Insomnia responses and user databases while offering old web cache', async () => {
    const app = await rule(platform, 'insomnia')
    const base = join(
      variables[
        platform === 'win32' ? 'APPDATA' : platform === 'darwin' ? 'APP_SUPPORT' : 'CONFIG'
      ],
      'Insomnia'
    )
    await file(join(base, 'responses', 'saved.response'))
    await file(join(base, 'insomnia.Response.db'))
    await file(join(base, 'insomnia.Request.db'))
    const old = await file(join(base, 'Cache', 'Cache_Data', 'old'))
    await file(join(base, 'Cache', 'Cache_Data', 'recent'), 0)

    expect((await scanAppRule(app, 'app')).items.map((item) => item.path)).toEqual([old])
  })

  it('preserves Hugging Face models and credentials and offers Xet caches once, as opt-in', async () => {
    const home = join(root, '.cache', 'huggingface')
    await file(join(home, 'hub', 'models--org--model', 'blobs', 'weights'))
    await file(join(home, 'hub', 'datasets--org--data', 'data.parquet'))
    await file(join(home, 'token'))
    const old = await file(join(home, 'xet', 'environment', 'chunk_cache', 'old'))
    await file(join(home, 'xet', 'environment', 'chunk_cache', 'recent'), 2)

    const app = await rule(platform, 'huggingface')
    const result = await scanAppRule(app, 'app')
    expect(new Set(app.paths).size).toBe(app.paths.length)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ path: old, selected: false, cacheReset: true })
    expect(result.totalSize).toBe(4096)

    state.exclusions = [old]
    expect((await scanAppRule(app, 'app')).items).toEqual([])
  })

  it('preserves Antigravity history and settings while offering settled cache files', async () => {
    const base = join(
      variables[
        platform === 'win32' ? 'APPDATA' : platform === 'darwin' ? 'APP_SUPPORT' : 'CONFIG'
      ],
      'Antigravity'
    )
    await file(join(base, 'User', 'History', 'session.json'))
    await file(join(base, 'User', 'settings.json'))
    const old = await file(join(base, 'Cache', 'Cache_Data', 'old'))
    await file(join(base, 'Cache', 'Cache_Data', 'recent'), 0)

    expect(
      (await scanAppRule(await rule(platform, 'antigravity'), 'app')).items.map((item) => item.path)
    ).toEqual([old])
  })
})

it('cleans only known, settled Windows Ollama logs without traversing other app state', async () => {
  const base = join(variables.LOCALAPPDATA, 'Ollama')
  const expected: string[] = []
  for (const name of ['app.log', 'upgrade.log', 'server-1.log', 'server-5.log']) {
    expected.push(await file(join(base, name)))
  }
  await file(join(base, 'server.log'), 0)
  await file(join(base, 'config.json'))
  await file(join(base, 'models', 'weights'))
  await file(join(base, 'unrelated', 'server.log'))
  const result = await scanAppRule(await rule('win32', 'ollama-logs'), 'app')
  expect(result.items.map((item) => item.path).sort()).toEqual(expected.sort())
  expect(result.items.every((item) => typeof item.recencyCutoff === 'number')).toBe(true)
})

it('does not advertise a Linux Ollama file cleaner for journal-based logs', async () => {
  expect((await rules('linux')).some((app) => app.id === 'ollama-logs')).toBe(false)
})
