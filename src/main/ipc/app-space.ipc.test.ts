import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppCacheDef } from '../platform/types'
import type { AppSpaceReport, AppSpaceReview, ScanResult } from '../../shared/types'
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  scan: vi.fn(),
  scanDirectory: vi.fn(),
  shaders: vi.fn(),
  redistributables: vi.fn(),
  launchers: [] as AppCacheDef[],
  gpu: [] as AppCacheDef[],
  safari: null as { cache: string } | null,
  inventory: vi.fn(),
  cache: vi.fn(),
  remove: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler)
  }
}))
vi.mock('../platform', () => ({
  getPlatform: () => ({
    paths: {
      appPaths: () => [
        { id: 'slack', name: 'Slack', paths: ['trusted-cache'] },
        { id: 'native', name: 'Native Tool', paths: ['native'], cleanupAction: 'uv-prune' }
      ],
      gamingPaths: () => mocks.launchers,
      gpuCachePaths: () => mocks.gpu,
      browserPaths: () => ({
        safari: mocks.safari,
        firefox: { cache: '' },
        librewolf: { cache: '' },
        waterfox: { cache: '' },
        floorp: { cache: '' }
      })
    }
  })
}))
vi.mock('./gaming-cleaner.ipc', () => ({
  scanSteamShaderCaches: mocks.shaders,
  scanSteamRedistributables: mocks.redistributables
}))
vi.mock('../services/program-uninstaller', () => ({ getInstalledProgramsFull: mocks.inventory }))
vi.mock('../services/file-utils', () => ({
  scanAppRule: mocks.scan,
  scanDirectory: mocks.scanDirectory
}))
vi.mock('../services/scan-cache', () => ({
  cacheItems: mocks.cache,
  removeCachedItems: mocks.remove
}))
vi.mock('../services/chromium-cache', () => ({
  chromiumBrowsers: () => [],
  chromiumCacheTargets: vi.fn(),
  BROWSER_CACHE_RECENCY: { deepRecencyCheck: true }
}))
import { registerAppSpaceIpc } from './app-space.ipc'
import { IPC } from '../../shared/channels'
const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args)
const result = (id: string): ScanResult => ({
  category: 'app',
  subcategory: 'Slack',
  totalSize: 150,
  itemCount: 1,
  items: [
    {
      id,
      path: 'trusted-cache/file',
      size: 150,
      category: 'app',
      subcategory: 'Slack',
      lastModified: 0,
      selected: true
    }
  ]
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.safari = null
  mocks.launchers = []
  mocks.gpu = []
  mocks.shaders.mockResolvedValue([])
  mocks.redistributables.mockResolvedValue([])
  registerAppSpaceIpc()
  mocks.inventory.mockResolvedValue([])
  mocks.scan.mockResolvedValue(result('fresh'))
})
describe('App Space IPC safety', () => {
  it('analyzes without caching cleanup IDs or invoking native managed commands', async () => {
    const report = (await invoke(IPC.APP_SPACE_SCAN)) as { entries: unknown[] }
    expect(report.entries).toHaveLength(1)
    expect(mocks.scan).toHaveBeenCalledTimes(1)
    expect(mocks.scan.mock.calls[0][0].id).toBe('slack')
    expect(mocks.cache).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })
  it('includes GPU and Steam per-game sources with truthful owners and preserves opt-in shader resets', async () => {
    mocks.gpu = [
      { id: 'nvidia', name: 'NVIDIA Shader Cache', paths: ['gpu-cache'], cacheReset: true }
    ]
    const shader = (id: string, game: string, path: string): ScanResult => ({
      category: 'gaming',
      subcategory: `${game} - Shader Cache`,
      group: 'Optional cache resets - next launch may be slower',
      itemCount: 1,
      totalSize: 128,
      items: [
        {
          id,
          path,
          size: 128,
          category: 'gaming',
          subcategory: `${game} - Shader Cache`,
          lastModified: 0,
          selected: false,
          cacheReset: true
        }
      ]
    })
    const firstGame = shader('shader-old', 'First Game', 'steam/shadercache/100')
    const secondGame = shader('second-old', 'Second Game', 'steam/shadercache/200')
    const gpu = shader('gpu-old', 'NVIDIA', 'gpu-cache/settled')
    mocks.scan.mockImplementation((definition: { id: string }) =>
      Promise.resolve(definition.id === 'nvidia' ? gpu : result('slack'))
    )
    mocks.shaders.mockResolvedValueOnce([firstGame, secondGame]).mockResolvedValueOnce([
      { ...firstGame, items: [{ ...firstGame.items[0], id: 'shader-fresh' }] },
      { ...secondGame, items: [{ ...secondGame.items[0], id: 'second-fresh' }] }
    ])
    const redist: ScanResult = {
      ...result('redist-old'),
      category: 'gaming',
      subcategory: 'First Game - Redistributables',
      group: 'Redistributables',
      items: [
        {
          ...result('redist-old').items[0],
          path: 'steam/common/First Game/_CommonRedist',
          category: 'gaming'
        }
      ]
    }
    mocks.redistributables
      .mockResolvedValueOnce([redist])
      .mockResolvedValueOnce([{ ...redist, items: [{ ...redist.items[0], id: 'redist-fresh' }] }])
    mocks.inventory.mockResolvedValue([
      { id: 'steam', displayName: 'Steam', publisher: 'Valve', estimatedSize: 1024 }
    ])
    const report = (await invoke(IPC.APP_SPACE_SCAN)) as AppSpaceReport
    expect(report.entries.find((entry) => entry.programId === 'steam')?.cacheBytes).toBe(0)
    expect(
      report.entries.find((entry) => entry.name === 'Steam per-game shader caches')?.cacheBytes
    ).toBe(256)
    expect(
      report.entries.find((entry) => entry.name === 'Steam game redistributable installers')
        ?.cacheBytes
    ).toBe(150)
    expect(report.entries.find((entry) => entry.name === 'NVIDIA Shader Cache')?.cacheBytes).toBe(
      128
    )
    expect(mocks.scan).toHaveBeenCalledWith(mocks.gpu[0], 'gaming', {
      directoryItems: true,
      group: 'GPU Shader Caches'
    })
    expect(mocks.cache).not.toHaveBeenCalled()
    const review = (await invoke(
      IPC.APP_SPACE_REVIEW,
      ['gaming:steam:per-game-shaders', 'gaming:steam:game-redistributables'],
      null
    )) as AppSpaceReview
    expect(review.results.flatMap((entry) => entry.items.map((item) => item.id))).toEqual([
      'shader-fresh',
      'second-fresh',
      'redist-fresh'
    ])
    expect(
      review.results
        .slice(0, 2)
        .every(
          (entry) =>
            entry.group === 'Optional cache resets - next launch may be slower' &&
            entry.items.every((item) => item.cacheReset === true && item.selected === false)
        )
    ).toBe(true)
    expect(review.results[2].subcategory).toBe('First Game - Redistributables')
    expect(mocks.shaders).toHaveBeenCalledTimes(2)
    expect(mocks.redistributables).toHaveBeenCalledTimes(2)
  })
  it('matches launcher scan options and deduplicates overlapping gaming sources in overview and fresh review', async () => {
    mocks.launchers = [{ id: 'steam', name: 'Steam Launcher', paths: ['steam/shadercache'] }]
    mocks.gpu = [{ id: 'shared', name: 'Shared Shader Cache', paths: ['steam/shadercache/100'] }]
    const source = (id: string, path: string): ScanResult => ({
      ...result(id),
      category: 'gaming',
      items: [{ ...result(id).items[0], path, category: 'gaming' }]
    })
    mocks.scan.mockImplementation((definition: { id: string }) =>
      Promise.resolve(
        definition.id === 'steam'
          ? source('launcher', 'steam/shadercache')
          : definition.id === 'shared'
            ? source('gpu', 'steam/shadercache/100')
            : result('slack')
      )
    )
    mocks.shaders.mockResolvedValue([source('game', 'steam/shadercache/100')])
    const report = (await invoke(IPC.APP_SPACE_SCAN)) as AppSpaceReport
    expect(
      report.entries
        .filter((entry) => entry.rules.some((rule) => rule.category === 'gaming'))
        .reduce((sum, entry) => sum + entry.cacheBytes, 0)
    ).toBe(150)
    expect(mocks.scan).toHaveBeenCalledWith(mocks.launchers[0], 'gaming', {
      directoryItems: true,
      group: 'Launcher Caches'
    })
    const review = (await invoke(
      IPC.APP_SPACE_REVIEW,
      ['gaming:steam', 'gaming:gpu:shared', 'gaming:steam:per-game-shaders'],
      null
    )) as AppSpaceReview
    expect(review.results.flatMap((entry) => entry.items)).toHaveLength(1)
    expect(review.results.reduce((sum, entry) => sum + entry.totalSize, 0)).toBe(150)
  })
  it('includes the macOS Safari cache in overview and a fresh browser cleanup review only', async () => {
    const cache = '/Users/Preview/Library/Caches/com.apple.Safari'
    mocks.safari = { cache }
    const safariResult: ScanResult = {
      category: 'browser',
      subcategory: 'Safari - Cache',
      itemCount: 1,
      totalSize: 512,
      items: [
        {
          id: 'safari-old',
          path: `${cache}/WebKitCache/file`,
          size: 512,
          category: 'browser',
          subcategory: 'Safari - Cache',
          lastModified: 0,
          selected: true
        }
      ]
    }
    mocks.scanDirectory.mockResolvedValueOnce(safariResult).mockResolvedValueOnce({
      ...safariResult,
      items: [{ ...safariResult.items[0], id: 'safari-fresh' }]
    })
    mocks.inventory.mockResolvedValue([
      { id: 'safari', displayName: 'Safari', publisher: 'Apple', estimatedSize: 1024 }
    ])
    const report = (await invoke(IPC.APP_SPACE_SCAN)) as AppSpaceReport
    const safari = report.entries.find((entry) => entry.name === 'Safari')!
    expect(safari.programId).toBe('safari')
    expect(safari.installedBytes).toBe(1024)
    expect(safari.cacheBytes).toBe(512)
    expect(safari.rules).toEqual([{ id: 'browser:safari', name: 'Safari', category: 'browser' }])
    expect(mocks.scanDirectory).toHaveBeenCalledExactlyOnceWith(
      cache,
      'browser',
      'Safari - Cache',
      { deepRecencyCheck: true }
    )
    expect(mocks.cache).not.toHaveBeenCalled()
    const review = (await invoke(IPC.APP_SPACE_REVIEW, ['browser:safari'], null)) as AppSpaceReview
    expect(review.results[0].category).toBe('browser')
    expect(review.results[0].items[0].id).toBe('safari-fresh')
    expect(mocks.scanDirectory).toHaveBeenCalledTimes(2)
    expect(mocks.scanDirectory.mock.calls.every(([path]) => path === cache)).toBe(true)
    await invoke(IPC.APP_SPACE_RETAIN, review.token, review.token)
    expect(mocks.cache).toHaveBeenCalledExactlyOnceWith(review.results[0].items)
  })
  it('does not expose a Safari rule when the platform has no Safari configuration', async () => {
    await expect(invoke(IPC.APP_SPACE_REVIEW, ['browser:safari'], null)).rejects.toThrow(
      'Unknown cleanup rule'
    )
    expect(mocks.scanDirectory).not.toHaveBeenCalled()
  })
  it('rejects renderer-supplied paths and unsupported managed rule IDs before scanning', async () => {
    await expect(invoke(IPC.APP_SPACE_REVIEW, ['C:/Users/Private'])).rejects.toThrow(
      'Unknown cleanup rule'
    )
    await expect(invoke(IPC.APP_SPACE_REVIEW, ['app:native'])).rejects.toThrow(
      'Unknown cleanup rule'
    )
    await expect(invoke(IPC.APP_SPACE_REVIEW, 'app:slack')).rejects.toThrow('Invalid rule IDs')
    expect(mocks.scan).not.toHaveBeenCalled()
  })
  it('freshly scans trusted rules and acknowledges compact tokens without touching unrelated IDs', async () => {
    mocks.scan.mockResolvedValueOnce(result('first')).mockResolvedValueOnce(result('second'))
    const first = (await invoke(IPC.APP_SPACE_REVIEW, ['app:slack'], null)) as AppSpaceReview
    await invoke(IPC.APP_SPACE_RETAIN, first.token, first.token)
    const second = (await invoke(
      IPC.APP_SPACE_REVIEW,
      ['app:slack'],
      first.token
    )) as AppSpaceReview
    expect(mocks.remove).not.toHaveBeenCalled()
    await invoke(IPC.APP_SPACE_RETAIN, second.token, second.token)
    expect(mocks.remove).toHaveBeenLastCalledWith(['first'])
    expect(mocks.cache).toHaveBeenLastCalledWith(result('second').items)
  })
  it('preserves the previous plan and discards fresh IDs when the UI cancels handoff', async () => {
    mocks.scan.mockResolvedValueOnce(result('previous')).mockResolvedValueOnce(result('canceled'))
    const previous = (await invoke(IPC.APP_SPACE_REVIEW, ['app:slack'], null)) as AppSpaceReview
    await invoke(IPC.APP_SPACE_RETAIN, previous.token, previous.token)
    const canceled = (await invoke(
      IPC.APP_SPACE_REVIEW,
      ['app:slack'],
      previous.token
    )) as AppSpaceReview
    await invoke(IPC.APP_SPACE_RETAIN, canceled.token, previous.token)
    expect(mocks.remove).toHaveBeenLastCalledWith(['canceled'])
  })
  it('does not retire previous review IDs when fresh scan returns no eligible items', async () => {
    const previous = (await invoke(IPC.APP_SPACE_REVIEW, ['app:slack'], null)) as AppSpaceReview
    await invoke(IPC.APP_SPACE_RETAIN, previous.token, previous.token)
    mocks.remove.mockClear()
    mocks.scan.mockResolvedValue({ ...result('empty'), items: [], itemCount: 0, totalSize: 0 })
    const empty = (await invoke(
      IPC.APP_SPACE_REVIEW,
      ['app:slack'],
      previous.token
    )) as AppSpaceReview
    expect(empty.results).toEqual([])
    await invoke(IPC.APP_SPACE_RETAIN, empty.token, previous.token)
    expect(mocks.remove.mock.calls.flat(2)).not.toContain('fresh')
  })
  it('supersedes unacknowledged drafts while preserving the current plan', async () => {
    mocks.scan
      .mockResolvedValueOnce(result('current'))
      .mockResolvedValueOnce(result('abandoned'))
      .mockResolvedValueOnce(result('latest'))
    const current = (await invoke(IPC.APP_SPACE_REVIEW, ['app:slack'], null)) as AppSpaceReview
    await invoke(IPC.APP_SPACE_RETAIN, current.token, current.token)
    const abandoned = (await invoke(
      IPC.APP_SPACE_REVIEW,
      ['app:slack'],
      current.token
    )) as AppSpaceReview
    const latest = (await invoke(
      IPC.APP_SPACE_REVIEW,
      ['app:slack'],
      current.token
    )) as AppSpaceReview
    expect(mocks.remove).toHaveBeenLastCalledWith(['abandoned'])
    await invoke(IPC.APP_SPACE_RETAIN, abandoned.token, current.token)
    await invoke(IPC.APP_SPACE_RETAIN, latest.token, latest.token)
    expect(mocks.remove).toHaveBeenLastCalledWith(['current'])
  })
  it('retains and supersedes a native review exceeding the old 250000-ID boundary', async () => {
    const items = Array.from({ length: 250001 }, (_, index) => ({
      ...result('sample').items[0],
      id: `large-${index}`,
      path: `trusted-cache/file-${index}`
    }))
    mocks.scan
      .mockResolvedValueOnce({
        ...result('large'),
        items,
        itemCount: items.length,
        totalSize: items.length * 150
      })
      .mockResolvedValueOnce(result('replacement'))
    const large = (await invoke(IPC.APP_SPACE_REVIEW, ['app:slack'], null)) as AppSpaceReview
    expect(large.results[0].itemCount).toBe(250001)
    await invoke(IPC.APP_SPACE_RETAIN, large.token, large.token)
    expect(mocks.remove).not.toHaveBeenCalled()
    const replacement = (await invoke(
      IPC.APP_SPACE_REVIEW,
      ['app:slack'],
      large.token
    )) as AppSpaceReview
    await invoke(IPC.APP_SPACE_RETAIN, replacement.token, replacement.token)
    expect(mocks.remove.mock.calls[0][0]).toHaveLength(250001)
    expect(mocks.remove.mock.calls[0][0][0]).toMatch(/^large-/)
    expect(mocks.remove.mock.calls[0][0]).not.toContain('replacement')
  })
  it('rejects concurrent native review scans to bound pending generations', async () => {
    let complete!: (value: ScanResult) => void
    mocks.scan.mockImplementationOnce(
      () =>
        new Promise<ScanResult>((resolve) => {
          complete = resolve
        })
    )
    const pending = invoke(IPC.APP_SPACE_REVIEW, ['app:slack'], null) as Promise<AppSpaceReview>
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    await expect(invoke(IPC.APP_SPACE_REVIEW, ['app:slack'], null)).rejects.toThrow(
      'already in progress'
    )
    complete(result('single'))
    const review = await pending
    await invoke(IPC.APP_SPACE_RETAIN, review.token, null)
    expect(mocks.cache).toHaveBeenCalledTimes(1)
  })
})
