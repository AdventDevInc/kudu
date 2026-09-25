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

import { checkForUpdates, resetWingetCache, runUpdates } from './software-updater'

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

// Regression tests for #475: an upgrade is judged by winget's exit code, not
// by English output text, so a localised Windows reports real results.
describe('runUpdates (winget)', () => {
  const ITALIAN_SUCCESS = [
    'Trovato DLSS Updater [Recol.DLSSUpdater] Versione 3.1.0',
    'Download in corso https://example.com/DLSS.Updater.3.1.0.exe',
    'Installazione riuscita',
    ''
  ].join('\r\n')

  interface Call {
    file: string
    args: string[]
  }

  /**
   * Script winget: `upgrade <id>` runs through `attempts` in order (the last
   * one repeats), the bare `upgrade` rescan returns `rescan`, and the
   * elevated PowerShell run returns `elevatedRun`.
   */
  function scriptUpgrade(
    attempts: Scripted[],
    rescan: Scripted = { stdout: '' },
    elevatedRun: Scripted = { stdout: '' }
  ): Call[] {
    const calls: Call[] = []
    let attempt = 0
    mockExecFile.mockImplementation((file: string, args: string[], _o: unknown, cb: ExecCb) => {
      calls.push({ file, args })
      let scripted: Scripted = { stdout: '' }
      if (file === 'powershell.exe') scripted = elevatedRun
      else if (args[0] === '--version') scripted = { stdout: 'v1.9.0' }
      else if (args[0] === 'upgrade' && args[1]?.startsWith('--')) scripted = rescan
      else if (args[0] === 'upgrade') scripted = attempts[Math.min(attempt++, attempts.length - 1)]
      if (scripted.error) {
        cb(
          Object.assign(new Error('failed'), { stdout: scripted.stdout ?? '' }, scripted.error),
          scripted.stdout ?? '',
          ''
        )
      } else {
        cb(null, scripted.stdout ?? '', '')
      }
    })
    return calls
  }

  const upgradeCalls = (calls: Call[]): Call[] =>
    calls.filter((c) => c.args[0] === 'upgrade' && !c.args[1]?.startsWith('--'))
  const elevated = (calls: Call[]): boolean => calls.some((c) => c.file === 'powershell.exe')
  const update = (id = 'Recol.DLSSUpdater') => runUpdates([{ id, source: 'winget' }], () => {})

  it('counts a clean exit as success whatever language winget speaks', async () => {
    const calls = scriptUpgrade([{ stdout: ITALIAN_SUCCESS }])

    const result = await update()
    expect(result).toEqual({ succeeded: 1, failed: 0, errors: [] })
    expect(upgradeCalls(calls)).toHaveLength(1)
  })

  it('counts "restart required to finish" as success', async () => {
    scriptUpgrade([{ stdout: ITALIAN_SUCCESS, error: { code: 0x8a150109 } }])

    const result = await update()
    expect(result.succeeded).toBe(1)
  })

  it('counts "no applicable update" as success: the app is already current', async () => {
    const calls = scriptUpgrade([
      { stdout: 'Nessun aggiornamento disponibile.\r\n', error: { code: 0x8a15002b } }
    ])

    const result = await update()
    expect(result).toEqual({ succeeded: 1, failed: 0, errors: [] })
    expect(upgradeCalls(calls)).toHaveLength(1)
  })

  it('does not retry a failure that retrying cannot fix', async () => {
    const calls = scriptUpgrade([
      { stdout: "L'applicazione è in esecuzione.\r\n", error: { code: 0x8a150101 } }
    ])

    const result = await update()
    expect(result.failed).toBe(1)
    expect(result.errors[0].reason).toBe('The app is running — close it and try again')
    expect(upgradeCalls(calls)).toHaveLength(1)
    expect(elevated(calls)).toBe(false)
  })

  it('retries an unknown localised failure elevated, then forced, and shows the exit code', async () => {
    const calls = scriptUpgrade(
      [{ stdout: 'Programma di installazione non riuscito: 1603\r\n', error: { code: 1603 } }],
      { stdout: UPGRADE_TABLE.replace('GitHub.cli', 'Recol.DLSSUpdater') }
    )

    const result = await update()
    expect(elevated(calls)).toBe(true)
    expect(upgradeCalls(calls).map((c) => c.args.includes('--force'))).toEqual([false, true])
    expect(result.errors[0].reason).toBe('Programma di installazione non riuscito: 1603 (0x643)')
  })

  it('treats an empty rescan after an elevated upgrade as success', async () => {
    scriptUpgrade([{ stdout: 'Accesso negato.\r\n', error: { code: 0x80070005 } }], {
      stdout: 'Nessun pacchetto installato trovato.\r\n',
      error: { code: 0x8a150014 }
    })

    const result = await update()
    expect(result).toEqual({ succeeded: 1, failed: 0, errors: [] })
  })

  it('accepts a reboot-pending exit from the elevated run', async () => {
    const calls = scriptUpgrade(
      [{ stdout: 'Accesso negato.\r\n', error: { code: 0x80070005 } }],
      { stdout: 'Nessun pacchetto installato trovato.\r\n', error: { code: 0x8a150014 } },
      // PowerShell hands back winget's HRESULT as a signed exit code
      { error: { code: 0x8a150109 | 0 } }
    )

    const result = await update()
    expect(result).toEqual({ succeeded: 1, failed: 0, errors: [] })
    expect(upgradeCalls(calls).some((c) => c.args.includes('--force'))).toBe(false)
  })
})
