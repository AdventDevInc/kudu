import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'

const { spawnTrackedLines, existsSync } = vi.hoisted(() => ({
  spawnTrackedLines: vi.fn(),
  existsSync: vi.fn()
}))
vi.mock('./exec-utf8', () => ({ spawnTrackedLines }))
vi.mock('fs', () => ({ existsSync }))

import { DATABASE_TIMEOUT_MS, optimizeDatabase } from './database-optimizer'

function reply(result: unknown, code: number | null = 0, timedOut = false): void {
  spawnTrackedLines.mockImplementation(async (_file, _args, onLine) => {
    if (result !== undefined) onLine(JSON.stringify(result))
    return { code, timedOut, stderr: '' }
  })
}

describe('database helper process', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    existsSync.mockReturnValue(true)
  })

  it('uses the Electron executable and bundled helper with a finite deadline', async () => {
    reply({ reclaimed: 4096 })
    await expect(optimizeDatabase('/data/state.vscdb')).resolves.toBe(4096)
    expect(spawnTrackedLines).toHaveBeenCalledWith(
      process.execPath,
      [join(__dirname, 'database-worker.js'), '/data/state.vscdb'],
      expect.any(Function),
      expect.objectContaining({
        timeout: DATABASE_TIMEOUT_MS,
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' })
      })
    )
  })

  it('finds the helper when the caller is in a Rollup chunks directory', async () => {
    existsSync.mockReturnValue(false)
    reply({ reclaimed: 0 })
    await optimizeDatabase('/data/test.db')
    expect(spawnTrackedLines.mock.calls[0][1][0]).toBe(join(__dirname, '..', 'database-worker.js'))
  })

  it('preserves SQLite error codes for in-use reporting', async () => {
    reply({ error: { code: 'SQLITE_BUSY', message: 'database is locked' } })
    await expect(optimizeDatabase('/data/state.vscdb')).rejects.toMatchObject({
      code: 'SQLITE_BUSY'
    })
  })

  it('reports timed-out maintenance as skipped even if output was emitted', async () => {
    reply({ reclaimed: 9999 }, null, true)
    await expect(optimizeDatabase('/data/state.vscdb')).rejects.toThrow('timed out')
  })

  it('rejects helper crashes without reporting reclaimed bytes', async () => {
    reply({ reclaimed: 9999 }, 1)
    await expect(optimizeDatabase('/data/test.db')).rejects.toThrow('process failed')
  })

  it.each([undefined, { reclaimed: -1 }, { reclaimed: '4096' }, {}])(
    'rejects invalid results: %j',
    async (result) => {
      reply(result)
      await expect(optimizeDatabase('/data/test.db')).rejects.toThrow()
    }
  )

  it('propagates startup errors without falling back to main-thread SQLite', async () => {
    spawnTrackedLines.mockRejectedValue(new Error('spawn failed'))
    await expect(optimizeDatabase('/data/test.db')).rejects.toThrow('spawn failed')
  })
})
