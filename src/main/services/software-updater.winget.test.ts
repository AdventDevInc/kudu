import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Regression tests for #462: the winget scan must never turn a failure (CLI
// not found, timeout, crash) or a localised table into "everything is up to
// date". Every scenario runs the real checkForUpdates() over a mocked winget.

const mockExecFile = vi.fn()
vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  // Mirror the real execFile's promisify shape: resolve { stdout, stderr }
  // and attach stdout/stderr to rejections.
  const execFile = (...args: unknown[]): unknown => mockExecFile(...args)
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: string[], opts: unknown) =>
      new Promise((resolve, reject) => {
        mockExecFile(file, args, opts, (err: unknown, stdout: string, stderr: string) => {
          if (err) reject(err)
          else resolve({ stdout, stderr })
        })
      })
  })
  return { execFile }
})
const mockExistsSync = vi.fn(() => false)
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readdirSync: () => []
}))
vi.mock('./elevation', () => ({ isAdmin: () => false }))
vi.mock('./settings-store', () => ({
  getSettings: () => ({ windowsPackageManagers: ['winget'] })
}))

import { checkForUpdates, resetWingetCache } from './software-updater'

type ExecCb = (err: unknown, stdout: string, stderr: string) => void

interface Scripted {
  stdout?: string
  /** Reject with this error (its stdout is attached like execFile does). */
  error?: Record<string, unknown>
}

/** Route each winget invocation to a scripted response keyed by subcommand. */
function scriptWinget(responses: Record<string, Scripted>): void {
  mockExecFile.mockImplementation((file: string, args: string[], _opts: unknown, cb: ExecCb) => {
    const key = args[0]
    const scripted = responses[key]
    if (!scripted) {
      cb(Object.assign(new Error(`unexpected ${file} ${key}`), { code: 'ENOENT' }), '', '')
      return
    }
    if (scripted.error) {
      const err = Object.assign(new Error(String(scripted.error.message ?? 'failed')), {
        stdout: scripted.stdout ?? '',
        stderr: '',
        ...scripted.error
      })
      cb(err, scripted.stdout ?? '', '')
      return
    }
    cb(null, scripted.stdout ?? '', '')
  })
}

const UPGRADE_TABLE = [
  'Name                Id                       Version        Available       Source',
  '------------------------------------------------------------------------------------',
  'Adobe Acrobat DC    XPDP273C0XHQH2           20.006.20042   26.001.21691    msstore',
  'GitHub CLI          GitHub.cli               2.100.0        2.101.0         winget',
  '2 upgrades available.',
  ''
].join('\r\n')

const originalPlatform = process.platform

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  resetWingetCache()
  mockExecFile.mockReset()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

describe('checkForUpdates (winget)', () => {
  it('reports outdated packages from the upgrade table', async () => {
    scriptWinget({ '--version': { stdout: 'v1.9.0' }, upgrade: { stdout: UPGRADE_TABLE } })

    const result = await checkForUpdates()
    expect(result.apps.map((a) => a.id)).toEqual(['XPDP273C0XHQH2', 'GitHub.cli'])
    expect(result.managers).toEqual([{ name: 'winget', available: true, outdatedCount: 2 }])
  })

  it('flags winget as errored when it cannot be started', async () => {
    scriptWinget({})

    const result = await checkForUpdates()
    expect(result.apps).toEqual([])
    expect(result.packageManagerAvailable).toBe(false)
    expect(result.managers[0]).toMatchObject({
      name: 'winget',
      available: false,
      error: expect.stringContaining('not found')
    })
  })

  it('falls back to a known install path when winget is not on PATH', async () => {
    const calls: string[] = []
    mockExecFile.mockImplementation((file: string, args: string[], _o: unknown, cb: ExecCb) => {
      calls.push(file)
      if (file === 'winget') {
        cb(Object.assign(new Error('spawn winget ENOENT'), { code: 'ENOENT' }), '', '')
      } else if (args[0] === '--version') {
        cb(null, 'v1.9.0', '')
      } else {
        cb(null, args[0] === 'upgrade' ? UPGRADE_TABLE : '', '')
      }
    })
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\me\\AppData\\Local')
    mockExistsSync.mockReturnValue(true)

    const result = await checkForUpdates()
    expect(result.apps).toHaveLength(2)
    expect(calls.some((f) => /WindowsApps[\\/]winget\.exe$/.test(f))).toBe(true)

    mockExistsSync.mockReturnValue(false)
    vi.unstubAllEnvs()
  })

  it('reports a timeout instead of "up to date"', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.9.0' },
      upgrade: { stdout: '   -\r   \\r', error: { killed: true, signal: 'SIGTERM' } }
    })

    const result = await checkForUpdates()
    expect(result.apps).toEqual([])
    expect(result.packageManagerAvailable).toBe(true)
    expect(result.managers[0]).toMatchObject({ name: 'winget', error: 'timed out' })
  })

  it('surfaces the last output line when winget exits with an unknown error', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.9.0' },
      upgrade: {
        stdout:
          'Failed in attempting to update the source: winget\r\nAn unexpected error occurred while executing the command:\r\n0x8a15000f : Data required by the source is missing\r\n',
        error: { code: 0x8a15000f }
      }
    })

    const result = await checkForUpdates()
    expect(result.apps).toEqual([])
    expect(result.managers[0].error).toContain('0x8a15000f')
  })

  it('treats the "no applications found" exit code as nothing outdated', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.9.0' },
      upgrade: {
        stdout: 'No installed package found matching input criteria.\r\n',
        error: { code: 0x8a150014 }
      },
      list: { stdout: '' }
    })

    const result = await checkForUpdates()
    expect(result.apps).toEqual([])
    expect(result.managers[0]).toEqual({ name: 'winget', available: true, outdatedCount: 0 })
  })

  it('keeps partial rows but flags the scan when winget is killed mid-table', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.9.0' },
      upgrade: { stdout: UPGRADE_TABLE, error: { killed: true, signal: 'SIGTERM' } }
    })

    const result = await checkForUpdates()
    expect(result.apps).toHaveLength(2)
    expect(result.managers[0]).toMatchObject({ outdatedCount: 2, error: 'timed out' })
  })

  it('flags a source failure even when a table was printed', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.9.0' },
      upgrade: {
        stdout: 'Failed in attempting to update the source: msstore\r\n' + UPGRADE_TABLE,
        error: { code: 0x8a15000f }
      }
    })

    const result = await checkForUpdates()
    expect(result.apps).toHaveLength(2)
    expect(result.managers[0].error).toBeDefined()
  })

  it('still parses the table when winget exits non-zero after printing it', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.9.0' },
      upgrade: { stdout: UPGRADE_TABLE, error: { code: 0x8a150014 } }
    })

    const result = await checkForUpdates()
    expect(result.apps).toHaveLength(2)
    expect(result.managers[0].error).toBeUndefined()
  })
})
