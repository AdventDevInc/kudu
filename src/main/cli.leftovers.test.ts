import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ scan: vi.fn(), clean: vi.fn() }))
vi.mock('./services/uninstall-leftovers', () => ({ scanForLeftovers: mocks.scan }))
vi.mock('./services/file-utils', () => ({ cleanItems: mocks.clean }))
import { handleLeftovers, ExitCode } from './cli'
import { clearCache, getCachedItems } from './services/scan-cache'
import type { ScanItem } from '../shared/types'
const ctx = { json: true, verbosity: 'quiet' as const }
const a: ScanItem = {
  id: 'fresh-a',
  path: 'C:\\Users\\Test\\AppData\\Local\\OldApp\\Cache',
  size: 2048,
  category: 'uninstallLeftovers',
  subcategory: 'Local',
  lastModified: 1,
  selected: false
}
const b: ScanItem = {
  ...a,
  id: 'fresh-b',
  path: 'C:\\Users\\Test\\AppData\\Local\\OtherApp\\Cache'
}
beforeEach(() => {
  clearCache()
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  mocks.scan.mockReset().mockResolvedValue([{ items: [a, b], itemCount: 2, totalSize: 4096 }])
  mocks.clean.mockReset().mockImplementation(async (ids: string[]) => {
    const resolved = getCachedItems(ids)
    return {
      filesDeleted: resolved.length,
      filesSkipped: ids.length - resolved.length,
      totalCleaned: resolved.reduce((n, i) => n + i.size, 0),
      errors: ids
        .filter((id) => !resolved.some((i) => i.id === id))
        .map((path) => ({ path, reason: 'scan-result-expired' }))
    }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  clearCache()
})
describe('leftovers CLI', () => {
  it.each([
    ['clean'],
    ['clean', '--all'],
    ['clean', '--path'],
    ['clean', '--path', 'relative'],
    ['clean', '--path', a.path, '--all'],
    ['scan', '--path', a.path]
  ])('rejects unsafe/invalid arguments %j', async (args) => {
    expect(await handleLeftovers(args, ctx)).toBe(ExitCode.INVALID_ARGS)
    expect(mocks.scan).not.toHaveBeenCalled()
    expect(mocks.clean).not.toHaveBeenCalled()
  })
  it('caches freshly scanned IDs and deletes only explicitly selected paths', async () => {
    expect(await handleLeftovers(['clean', '--path', a.path], ctx)).toBe(ExitCode.SUCCESS)
    expect(mocks.clean).toHaveBeenCalledWith(['fresh-a'], undefined, 'cli')
    expect(getCachedItems(['fresh-b'])).toEqual([])
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('"filesDeleted": 1'))
  })
  it('accepts repeated paths case-insensitively without duplicate deletion', async () => {
    expect(
      await handleLeftovers(['clean', '--path', a.path.toUpperCase(), '--path', a.path], ctx)
    ).toBe(ExitCode.SUCCESS)
    expect(mocks.clean).toHaveBeenCalledWith(['fresh-a'], undefined, 'cli')
  })
  it('supports explicit selection of multiple paths', async () => {
    expect(await handleLeftovers(['clean', '--path', a.path, '--path', b.path], ctx)).toBe(
      ExitCode.SUCCESS
    )
    expect(mocks.clean).toHaveBeenCalledWith(['fresh-a', 'fresh-b'], undefined, 'cli')
  })
  it('rejects the entire selection if one path is no longer safe or contains a wildcard', async () => {
    expect(
      await handleLeftovers(['clean', '--path', a.path, '--path', 'C:\\Users\\Test\\*'], ctx)
    ).toBe(ExitCode.INVALID_ARGS)
    expect(mocks.clean).not.toHaveBeenCalled()
  })
  it('returns a nonzero exit for a stale selection with no scan results', async () => {
    mocks.scan.mockResolvedValue([])
    expect(await handleLeftovers(['clean', '--path', a.path], ctx)).toBe(ExitCode.INVALID_ARGS)
    expect(mocks.clean).not.toHaveBeenCalled()
  })
  it('reports scan results without caching or deleting them', async () => {
    await handleLeftovers(['scan'], ctx)
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('fresh-a'))
    expect(getCachedItems(['fresh-a'])).toEqual([])
    expect(mocks.clean).not.toHaveBeenCalled()
  })
  it.each([
    [{ filesDeleted: 0, errors: [{ reason: 'scan-result-expired' }] }, ExitCode.GENERAL_ERROR],
    [{ filesDeleted: 1, errors: [{ reason: 'file-locked' }] }, ExitCode.PARTIAL_SUCCESS],
    [{ filesDeleted: 0, errors: [{}], needsElevation: true }, ExitCode.PERMISSION_DENIED]
  ])('preserves failure exit status %j', async (result, expected) => {
    mocks.clean.mockResolvedValue(result)
    expect(await handleLeftovers(['clean', '--path', a.path], ctx)).toBe(expected)
  })
  it('never deletes after a failed inventory query', async () => {
    mocks.scan.mockRejectedValue(new Error('Inventory failed'))
    await expect(handleLeftovers(['clean', '--path', a.path], ctx)).rejects.toThrow(
      'Inventory failed'
    )
    expect(mocks.clean).not.toHaveBeenCalled()
  })
})
