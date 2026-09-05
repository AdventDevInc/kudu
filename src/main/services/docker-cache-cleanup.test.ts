import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ context: 'desktop-linux', endpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine', daemon: 'engine-1', exclusions: [] as string[] }))
vi.mock('./exec-utf8', () => ({ execTracked: vi.fn() }))
vi.mock('./settings-store', () => ({ getSettings: () => ({ exclusions: state.exclusions }) }))
vi.mock('./elevation', () => ({ isAdmin: () => false }))
import { execTracked } from './exec-utf8'
import { scanManagedCleanup, runManagedCleanup } from './managed-cleanup'

async function scan() { return scanManagedCleanup('docker-build-prune', 'app', 'Docker Build Cache', '/unused') }
beforeEach(() => {
  state.context = 'desktop-linux'; state.endpoint = 'npipe:////./pipe/dockerDesktopLinuxEngine'; state.daemon = 'engine-1'; state.exclusions = []
  vi.mocked(execTracked).mockReset().mockImplementation(async (_file, args) => {
    if (args[0] === 'context' && args[1] === 'show') return { stdout: state.context, stderr: '' }
    if (args[0] === 'context' && args[1] === 'inspect') return { stdout: JSON.stringify([{ Endpoints: { docker: { Host: state.endpoint } } }]), stderr: '' }
    if (args.includes('info')) return { stdout: state.daemon, stderr: '' }
    if (args.includes('prune')) return { stdout: 'Total reclaimed space: 0B', stderr: '' }
    throw new Error('Unexpected Docker command')
  })
})
afterEach(() => vi.unstubAllEnvs())

describe('Docker build cache maintenance', () => {
  it('previews the local engine and retention policy without pruning or selecting it', async () => {
    const result = await scan()
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ selected: false, size: 0, dockerTarget: { context: state.context, endpoint: state.endpoint, daemonId: state.daemon } })
    expect(result.subcategory).toContain('unused 7 days; keep 10 GB')
    expect(vi.mocked(execTracked).mock.calls.some(([, args]) => args.includes('prune'))).toBe(false)
  })
  it('pins pruning to the scanned local socket and bounds cache removal', async () => {
    vi.stubEnv('DOCKER_CONTEXT', 'remote-context')
    vi.stubEnv('DOCKER_HOST', 'tcp://remote:2375')
    const item = (await scan()).items[0]
    expect(await runManagedCleanup(item)).toEqual({ success: true })
    expect(execTracked).toHaveBeenLastCalledWith('docker', [
      '--host', state.endpoint, 'builder', 'prune', '--force', '--filter', 'until=168h', '--keep-storage', '10GB',
    ], expect.objectContaining({ timeout: 300_000 }))
    const env = vi.mocked(execTracked).mock.calls.at(-1)![2]!.env!
    expect(env.DOCKER_CONTEXT).toBeUndefined()
    expect(env.DOCKER_HOST).toBeUndefined()
  })
  it.each(['ssh://server', 'tcp://localhost:2375', 'npipe:////remote/pipe/docker_engine', 'unix://remote/socket'])('withholds unsupported or remote endpoint %s', async (endpoint) => {
    state.endpoint = endpoint
    expect((await scan()).items).toEqual([])
    expect(vi.mocked(execTracked).mock.calls.some(([, args]) => args.includes('info') || args.includes('prune'))).toBe(false)
  })
  it.each(['context', 'endpoint', 'daemon'] as const)('requires rescanning when %s changes', async (field) => {
    const item = (await scan()).items[0]
    state[field] = field === 'endpoint' ? 'unix:///var/run/docker.sock' : 'changed'
    expect((await runManagedCleanup(item)).success).toBe(false)
    expect(vi.mocked(execTracked).mock.calls.some(([, args]) => args.includes('prune'))).toBe(false)
  })
  it('honors exclusions added after scanning', async () => {
    const item = (await scan()).items[0]
    state.exclusions = ['keep']
    expect((await runManagedCleanup(item)).success).toBe(false)
    expect((await scan()).items).toEqual([])
  })
  it('leaves unavailable Docker hidden and reports a failed prune without fallback', async () => {
    const item = (await scan()).items[0]
    const original = vi.mocked(execTracked).getMockImplementation()!
    vi.mocked(execTracked).mockImplementation(async (...args) => {
      if (args[1].includes('prune')) throw new Error('Docker disconnected')
      return original(...args)
    })
    expect(await runManagedCleanup(item)).toEqual({ success: false, reason: 'Docker disconnected' })
    vi.mocked(execTracked).mockRejectedValue(new Error('Docker unavailable'))
    expect((await scan()).items).toEqual([])
  })
})
