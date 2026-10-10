import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSpaceReview, ScanResult } from '../../shared/types'
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
