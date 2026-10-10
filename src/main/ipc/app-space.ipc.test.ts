import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScanResult } from '../../shared/types'
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  scan: vi.fn(),
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
      gamingPaths: () => [],
      browserPaths: () => ({
        firefox: { cache: '' },
        librewolf: { cache: '' },
        waterfox: { cache: '' },
        floorp: { cache: '' }
      })
    }
  })
}))
vi.mock('../services/program-uninstaller', () => ({ getInstalledProgramsFull: mocks.inventory }))
vi.mock('../services/file-utils', () => ({ scanAppRule: mocks.scan, scanDirectory: vi.fn() }))
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
  it('freshly scans trusted rule definitions and retires only its own previous handoff IDs', async () => {
    mocks.scan.mockResolvedValueOnce(result('first')).mockResolvedValueOnce(result('second'))
    await invoke(IPC.APP_SPACE_REVIEW, ['app:slack'])
    await invoke(IPC.APP_SPACE_REVIEW, ['app:slack'])
    expect(mocks.scan).toHaveBeenCalledTimes(2)
    expect(mocks.remove).not.toHaveBeenCalled()
    await invoke(IPC.APP_SPACE_RETAIN, ['second', 'unrelated-cleaner-id'])
    expect(mocks.remove).toHaveBeenLastCalledWith(['first'])
    expect(mocks.cache).toHaveBeenLastCalledWith(result('second').items)
  })
  it('preserves the previous plan and discards fresh IDs when the UI cancels handoff', async () => {
    mocks.scan.mockResolvedValueOnce(result('previous')).mockResolvedValueOnce(result('canceled'))
    await invoke(IPC.APP_SPACE_REVIEW, ['app:slack'])
    await invoke(IPC.APP_SPACE_RETAIN, ['previous'])
    await invoke(IPC.APP_SPACE_REVIEW, ['app:slack'])
    await invoke(IPC.APP_SPACE_RETAIN, ['previous'])
    expect(mocks.remove).toHaveBeenLastCalledWith(['canceled'])
  })
  it('does not retire existing review IDs when fresh scan returns no eligible items', async () => {
    await invoke(IPC.APP_SPACE_REVIEW, ['app:slack'])
    mocks.remove.mockClear()
    mocks.scan.mockResolvedValue({ ...result('empty'), items: [], itemCount: 0, totalSize: 0 })
    expect(await invoke(IPC.APP_SPACE_REVIEW, ['app:slack'])).toEqual([])
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})
