import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  switches: [] as string[],
  listeners: {} as Record<string, Array<(...args: unknown[]) => void>>,
  relaunch: vi.fn(),
  exit: vi.fn(),
  dataDir: { value: '' },
}))

vi.mock('electron', () => ({
  app: {
    commandLine: { appendSwitch: (name: string) => h.switches.push(name) },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      ;(h.listeners[event] ??= []).push(cb)
    },
    relaunch: h.relaunch,
    exit: h.exit,
  },
}))

vi.mock('./settings-store', () => ({ getDataDir: () => h.dataDir.value }))

const markerPath = () => join(h.dataDir.value, '.disable-gpu')

// Re-import per test so the module-level `attemptedRecovery` flag is fresh.
async function load() {
  vi.resetModules()
  return import('./gpu-fallback')
}

const fireGpuGone = (reason = 'launch-failed') =>
  h.listeners['child-process-gone'][0]({}, { type: 'GPU', reason })

describe('gpu-fallback', () => {
  beforeEach(() => {
    h.dataDir.value = mkdtempSync(join(tmpdir(), 'kudu-gpu-'))
    h.switches.length = 0
    for (const k of Object.keys(h.listeners)) delete h.listeners[k]
    h.relaunch.mockClear()
    h.exit.mockClear()
    process.argv = ['node', 'kudu']
    delete process.env.KUDU_DISABLE_GPU
  })

  afterEach(() => {
    rmSync(h.dataDir.value, { recursive: true, force: true })
  })

  it('is off by default', async () => {
    const { shouldDisableGpu } = await load()
    expect(shouldDisableGpu()).toBe(false)
  })

  it('honors the --disable-gpu flag', async () => {
    process.argv = ['node', 'kudu', '--disable-gpu']
    const { shouldDisableGpu } = await load()
    expect(shouldDisableGpu()).toBe(true)
  })

  it('honors the KUDU_DISABLE_GPU env var', async () => {
    process.env.KUDU_DISABLE_GPU = '1'
    const { shouldDisableGpu } = await load()
    expect(shouldDisableGpu()).toBe(true)
  })

  it('honors a persisted marker file', async () => {
    writeFileSync(markerPath(), '')
    const { shouldDisableGpu } = await load()
    expect(shouldDisableGpu()).toBe(true)
  })

  it('appends the GPU-disabling switches', async () => {
    const { applyGpuFallbackSwitches } = await load()
    applyGpuFallbackSwitches()
    expect(h.switches).toContain('disable-gpu')
    expect(h.switches).toContain('disable-gpu-sandbox')
  })

  it('writes a marker and relaunches on GPU launch failure', async () => {
    const { registerGpuCrashRecovery } = await load()
    registerGpuCrashRecovery()
    fireGpuGone()

    expect(existsSync(markerPath())).toBe(true)
    expect(h.relaunch).toHaveBeenCalledTimes(1)
    expect(h.relaunch.mock.calls[0][0].args).toContain('--disable-gpu')
    expect(h.exit).toHaveBeenCalledTimes(1)
  })

  it('ignores non-GPU process exits', async () => {
    const { registerGpuCrashRecovery } = await load()
    registerGpuCrashRecovery()
    h.listeners['child-process-gone'][0]({}, { type: 'Utility', reason: 'crashed' })
    expect(h.relaunch).not.toHaveBeenCalled()
  })

  it('does not relaunch more than once', async () => {
    const { registerGpuCrashRecovery } = await load()
    registerGpuCrashRecovery()
    fireGpuGone()
    fireGpuGone()
    expect(h.relaunch).toHaveBeenCalledTimes(1)
  })
})
