import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'path'
const state = vi.hoisted(() => ({ exclusions: [] as string[], admin: true }))
vi.mock('./settings-store', () => ({ getSettings: () => ({ exclusions: state.exclusions }) }))
vi.mock('./elevation', () => ({ isAdmin: () => state.admin }))
vi.mock('./exec-utf8', () => ({ execTracked: vi.fn() }))
vi.mock('fs/promises', () => ({ lstat: vi.fn(async () => ({ isDirectory: () => true, isSymbolicLink: () => false })) }))
import { execTracked } from './exec-utf8'
import { scanManagedCleanup, runManagedCleanup } from './managed-cleanup'
import type { ScanItem } from '../../shared/types'
const cache = resolve('test-cache')
beforeEach(() => {
  state.exclusions = []; state.admin = true
  vi.mocked(execTracked).mockReset().mockResolvedValue({ stdout: cache, stderr: '' })
})
async function uvItem() { return (await scanManagedCleanup('uv-prune', 'app', 'uv', cache)).items[0] }
describe('native cleanup', () => {
  it('discovers the configured uv cache without pruning and leaves it unselected', async () => {
    const item = await uvItem()
    expect(item).toMatchObject({ path: cache, size: 0, selected: false, cleanupAction: 'uv-prune' })
    expect(execTracked).toHaveBeenCalledTimes(1)
    expect(execTracked).toHaveBeenCalledWith('uv', ['cache', 'dir'], expect.anything())
  })
  it('prunes through uv rather than deleting a cache directory', async () => {
    const item = await uvItem()
    expect(await runManagedCleanup(item)).toEqual({ success: true })
    expect(execTracked).toHaveBeenLastCalledWith('uv', ['cache', 'prune'], expect.anything())
  })
  it('withholds native operations when exclusions are configured', async () => {
    state.exclusions = ['*.log']
    expect((await scanManagedCleanup('uv-prune', 'app', 'uv', cache)).items).toEqual([])
    expect(execTracked).not.toHaveBeenCalled()
  })
  it('rechecks exclusions and cache location before cleanup', async () => {
    const item = await uvItem()
    state.exclusions = ['keep']
    expect((await runManagedCleanup(item)).success).toBe(false)
    state.exclusions = []
    vi.mocked(execTracked).mockResolvedValue({ stdout: resolve('other-cache'), stderr: '' })
    expect((await runManagedCleanup(item)).success).toBe(false)
    expect(execTracked).not.toHaveBeenCalledWith('uv', ['cache', 'prune'], expect.anything())
  })
  it('does not fall back to raw deletion when a tool is missing or fails', async () => {
    vi.mocked(execTracked).mockRejectedValue(new Error('tool unavailable'))
    expect((await scanManagedCleanup('pnpm-prune', 'app', 'pnpm', cache)).items).toEqual([])
    const item = { cleanupAction: 'uv-prune', path: cache } as ScanItem
    expect((await runManagedCleanup(item)).success).toBe(false)
  })
  it('rejects unknown actions', async () => {
    expect((await runManagedCleanup({ cleanupAction: 'arbitrary-command' } as any)).success).toBe(false)
    expect(execTracked).not.toHaveBeenCalled()
  })
  it.skipIf(process.platform !== 'win32')('uses supported Windows commands without ResetBase or pinned-file removal', async () => {
    const component = (await scanManagedCleanup('windows-components', 'system', 'Components', cache)).items[0]
    expect(await runManagedCleanup(component)).toEqual({ success: true })
    expect(execTracked).toHaveBeenCalledWith(expect.stringMatching(/dism\.exe$/), ['/Online', '/Cleanup-Image', '/StartComponentCleanup', '/NoRestart'], expect.anything())
    const delivery = (await scanManagedCleanup('delivery-optimization', 'system', 'Delivery', cache)).items[0]
    expect(await runManagedCleanup(delivery)).toEqual({ success: true })
    const command = vi.mocked(execTracked).mock.calls.at(-1)![1].join(' ')
    expect(command).toContain('Delete-DeliveryOptimizationCache -Force')
    expect(command).not.toContain('IncludePinnedFiles')
  })
})
