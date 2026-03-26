import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mock external dependencies before importing the module ──────────

// The module does `promisify(execFile)` at the top level.
// We mock child_process.execFile as a callback-style function AND attach
// a custom promisify symbol so that `util.promisify(execFile)` returns
// our promise-based mock directly.

const execFileAsyncMock = vi.fn<(...args: unknown[]) => Promise<{ stdout: string; stderr: string }>>()

const execFileMockFn: any = vi.fn()
// Node's promisify checks for this custom symbol first
execFileMockFn[Symbol.for('nodejs.util.promisify.custom')] = execFileAsyncMock

vi.mock('child_process', () => ({
  execFile: execFileMockFn
}))

vi.mock('../services/exec-utf8', () => ({
  execNativeUtf8: (tool: string, args: string[], opts?: any) => execFileAsyncMock(tool, args, opts),
  psUtf8: (cmd: string) => cmd,
}))

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true)
}))

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path')
  return { ...actual, join: (...args: string[]) => args.join('/') }
})

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    app: {
      isPackaged: false,
      getPath: () => '/mock/userData'
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }),
      _handlers: handlers
    },
    BrowserWindow: vi.fn()
  }
})

vi.mock('../platform', () => ({
  getPlatform: () => ({
    privacy: {
      getSettings: () => []
    }
  })
}))

vi.mock('../services/ipc-validation', () => ({
  validateStringArray: vi.fn((input: unknown, _maxItems?: number) => {
    if (!Array.isArray(input)) return null
    if (!input.every((v: unknown) => typeof v === 'string')) return null
    return input as string[]
  })
}))

// ─── Helpers ─────────────────────────────────────────────────────

function setupExecFile(impl: (cmd: string, args: string[], opts?: object) => { stdout: string; stderr?: string }) {
  execFileAsyncMock.mockImplementation((...callArgs: unknown[]) => {
    try {
      const result = impl(callArgs[0] as string, callArgs[1] as string[], callArgs[2] as object)
      return Promise.resolve({ stdout: result.stdout, stderr: result.stderr ?? '' })
    } catch (err) {
      return Promise.reject(err)
    }
  })
}

function setupExecFileReject(err: Error | string = new Error('not found')) {
  execFileAsyncMock.mockRejectedValue(typeof err === 'string' ? new Error(err) : err)
}

// Force process.platform to win32 so getSettingsForPlatform() returns SETTINGS
const originalPlatform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

// ─── Import after mocks ──────────────────────────────────────────

import { ipcMain } from 'electron'
import { IPC } from '../../shared/channels'
import { validateStringArray } from '../services/ipc-validation'

let scanPrivacy: typeof import('./privacy-shield.ipc').scanPrivacy
let applyPrivacySettings: typeof import('./privacy-shield.ipc').applyPrivacySettings
let revertPrivacySettings: typeof import('./privacy-shield.ipc').revertPrivacySettings
let registerPrivacyShieldIpc: typeof import('./privacy-shield.ipc').registerPrivacyShieldIpc
let PRIVACY_SETTINGS: typeof import('./privacy-shield.ipc').PRIVACY_SETTINGS

beforeEach(async () => {
  vi.clearAllMocks()
  setupExecFile(() => ({ stdout: '', stderr: '' }))

  const mod = await import('./privacy-shield.ipc')
  scanPrivacy = mod.scanPrivacy
  applyPrivacySettings = mod.applyPrivacySettings
  revertPrivacySettings = mod.revertPrivacySettings
  registerPrivacyShieldIpc = mod.registerPrivacyShieldIpc
  PRIVACY_SETTINGS = mod.PRIVACY_SETTINGS
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ═══════════════════════════════════════════════════════════════════
// SETTING DEFINITIONS
// ═══════════════════════════════════════════════════════════════════

describe('PRIVACY_SETTINGS definitions', () => {
  it('exports a non-empty array of settings', () => {
    expect(Array.isArray(PRIVACY_SETTINGS)).toBe(true)
    expect(PRIVACY_SETTINGS.length).toBeGreaterThan(0)
  })

  it('every setting has required fields', () => {
    for (const s of PRIVACY_SETTINGS) {
      expect(typeof s.id).toBe('string')
      expect(s.id.length).toBeGreaterThan(0)
      expect(typeof s.category).toBe('string')
      expect(typeof s.label).toBe('string')
      expect(typeof s.description).toBe('string')
      expect(typeof s.requiresAdmin).toBe('boolean')
      expect(typeof s.check).toBe('function')
      expect(typeof s.apply).toBe('function')
    }
  })

  it('has no duplicate setting IDs', () => {
    const ids = PRIVACY_SETTINGS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('all categories are valid PrivacySetting categories', () => {
    const validCategories = new Set([
      'telemetry', 'ads', 'search', 'services', 'tasks', 'sync',
      'kernel', 'network', 'access', 'ai', 'browser'
    ])
    for (const s of PRIVACY_SETTINGS) {
      expect(validCategories.has(s.category)).toBe(true)
    }
  })

  it('dependsOn references exist if specified', () => {
    const allIds = new Set(PRIVACY_SETTINGS.map(s => s.id))
    for (const s of PRIVACY_SETTINGS) {
      if (s.dependsOn) {
        expect(allIds.has(s.dependsOn)).toBe(true)
      }
    }
  })

  it('service-category settings that directly manage service start type have applicable()', () => {
    // Settings like service-diagtrack, service-dmwappush, service-mapsbroker use
    // disableService/enableService and must have applicable() to check serviceExists.
    // But service-delivery-optimization uses regSetDword directly and does not need applicable.
    const directServiceSettings = PRIVACY_SETTINGS.filter(s =>
      s.category === 'services' && s.id.startsWith('service-') && s.id !== 'service-delivery-optimization'
    )
    for (const s of directServiceSettings) {
      if (typeof s.revert === 'function') {
        expect(typeof s.applicable).toBe('function')
      }
    }
  })

  it('task-category settings all have applicable()', () => {
    const taskSettings = PRIVACY_SETTINGS.filter(s => s.category === 'tasks')
    for (const s of taskSettings) {
      expect(typeof s.applicable).toBe('function')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
// REGISTRY HELPER LOGIC (tested via setting check/apply/revert)
// ═══════════════════════════════════════════════════════════════════

describe('registry operations via settings', () => {
  describe('regQueryDword — check() behavior', () => {
    it('returns true (privacy-friendly) when registry value matches expected', async () => {
      setupExecFile((_cmd, args) => {
        if (args[0] === 'query' && args[3] === 'AllowTelemetry') {
          return { stdout: '    AllowTelemetry    REG_DWORD    0x0' }
        }
        return { stdout: '' }
      })

      const setting = PRIVACY_SETTINGS.find(s => s.id === 'telemetry-level')!
      expect(await setting.check()).toBe(true)
    })

    it('returns false when registry value does not match', async () => {
      setupExecFile((_cmd, args) => {
        if (args[0] === 'query') {
          return { stdout: '    AllowTelemetry    REG_DWORD    0x1' }
        }
        return { stdout: '' }
      })

      const setting = PRIVACY_SETTINGS.find(s => s.id === 'telemetry-level')!
      expect(await setting.check()).toBe(false)
    })

    it('returns false (null) when registry query fails', async () => {
      setupExecFileReject()

      const setting = PRIVACY_SETTINGS.find(s => s.id === 'telemetry-level')!
      expect(await setting.check()).toBe(false)
    })

    it('parses hex values correctly from reg query output', async () => {
      setupExecFile((_cmd, args) => {
        if (args[0] === 'query' && args[3] === 'DisableSettingSync') {
          return { stdout: '    DisableSettingSync    REG_DWORD    0x2' }
        }
        return { stdout: '' }
      })

      const setting = PRIVACY_SETTINGS.find(s => s.id === 'settings-sync')!
      expect(await setting.check()).toBe(true) // expects val === 2
    })

    it('handles check that expects val === 1 (e.g. DisableSearchBoxSuggestions)', async () => {
      setupExecFile((_cmd, args) => {
        if (args[0] === 'query' && args[3] === 'DisableSearchBoxSuggestions') {
          return { stdout: '    DisableSearchBoxSuggestions    REG_DWORD    0x1' }
        }
        return { stdout: '' }
      })

      const setting = PRIVACY_SETTINGS.find(s => s.id === 'bing-start-menu')!
      expect(await setting.check()).toBe(true)
    })
  })

  describe('regSetDword — apply() behavior', () => {
    it('calls reg add with correct arguments for telemetry-level', async () => {
      const calls: { cmd: string; args: string[] }[] = []
      setupExecFile((cmd, args) => {
        calls.push({ cmd, args })
        return { stdout: '' }
      })

      const setting = PRIVACY_SETTINGS.find(s => s.id === 'telemetry-level')!
      await setting.apply()

      const addCall = calls.find(c => c.args[0] === 'add')
      expect(addCall).toBeDefined()
      expect(addCall!.cmd).toBe('reg')
      expect(addCall!.args).toContain('/t')
      expect(addCall!.args).toContain('REG_DWORD')
      expect(addCall!.args).toContain('/f')
      expect(addCall!.args).toContain('0') // AllowTelemetry = 0
    })

    it('propagates errors from reg add', async () => {
      setupExecFileReject(new Error('Access denied'))

      const setting = PRIVACY_SETTINGS.find(s => s.id === 'telemetry-level')!
      await expect(setting.apply()).rejects.toThrow('Access denied')
    })
  })

  describe('regDeleteValue — revert() behavior', () => {
    it('calls reg delete with /f flag', async () => {
      const calls: { cmd: string; args: string[] }[] = []
      setupExecFile((cmd, args) => {
        calls.push({ cmd, args })
        return { stdout: '' }
      })

      const setting = PRIVACY_SETTINGS.find(s => s.id === 'telemetry-level')!
      await setting.revert!()

      const deleteCall = calls.find(c => c.args[0] === 'delete')
      expect(deleteCall).toBeDefined()
      expect(deleteCall!.args).toContain('/f')
    })

    it('swallows "unable to find" errors (idempotent delete)', async () => {
      const err = new Error('unable to find the specified registry')
      ;(err as any).stderr = 'ERROR: unable to find the specified registry key or value'
      execFileAsyncMock.mockRejectedValue(err)

      const setting = PRIVACY_SETTINGS.find(s => s.id === 'telemetry-level')!
      // Should not throw
      await setting.revert!()
    })

    it('re-throws non "unable to find" errors', async () => {
      execFileAsyncMock.mockRejectedValue(new Error('Access is denied'))

      const setting = PRIVACY_SETTINGS.find(s => s.id === 'telemetry-level')!
      await expect(setting.revert!()).rejects.toThrow('Access is denied')
    })

    it('some settings revert via regSetDword instead of regDelete', async () => {
      const calls: { cmd: string; args: string[] }[] = []
      setupExecFile((cmd, args) => {
        calls.push({ cmd, args })
        return { stdout: '' }
      })

      // handwriting-telemetry reverts by setting Enabled=1
      const setting = PRIVACY_SETTINGS.find(s => s.id === 'handwriting-telemetry')!
      await setting.revert!()

      const addCall = calls.find(c => c.args[0] === 'add')
      expect(addCall).toBeDefined()
      expect(addCall!.args).toContain('1') // reverts to Enabled=1
    })
  })
})

// ═══════════════════════════════════════════════════════════════════
// TASK SCHEDULER OPERATIONS
// ═══════════════════════════════════════════════════════════════════

describe('task scheduler operations', () => {
  it('check returns false when task is active (Enabled=true in XML)', async () => {
    setupExecFile((cmd, args) => {
      if (cmd === 'schtasks' && args[0] === '/query') {
        return { stdout: '<?xml version="1.0"?><Task><Settings><Enabled>true</Enabled></Settings></Task>' }
      }
      return { stdout: '' }
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'task-compatibility-appraiser')!
    expect(await setting.check()).toBe(false) // !(isTaskActive=true) = false
  })

  it('check returns true when task is disabled (Enabled=false in XML)', async () => {
    setupExecFile((cmd, args) => {
      if (cmd === 'schtasks' && args[0] === '/query') {
        return { stdout: '<?xml version="1.0"?><Task><Settings><Enabled>false</Enabled></Settings></Task>' }
      }
      return { stdout: '' }
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'task-compatibility-appraiser')!
    expect(await setting.check()).toBe(true)
  })

  it('check returns false when task is active but a trigger has Enabled=false', async () => {
    setupExecFile((cmd, args) => {
      if (cmd === 'schtasks' && args[0] === '/query') {
        return {
          stdout: '<?xml version="1.0"?><Task>'
            + '<Triggers><TimeTrigger><Enabled>false</Enabled></TimeTrigger></Triggers>'
            + '<Settings><Enabled>true</Enabled></Settings>'
            + '</Task>'
        }
      }
      return { stdout: '' }
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'task-compatibility-appraiser')!
    expect(await setting.check()).toBe(false) // task itself is enabled -> active -> not privacy-friendly
  })

  it('check returns true when task does not exist (query throws)', async () => {
    setupExecFileReject()

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'task-compatibility-appraiser')!
    expect(await setting.check()).toBe(true) // task not found -> not active -> privacy-friendly
  })

  it('apply calls schtasks /change /disable', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    setupExecFile((cmd, args) => {
      calls.push({ cmd, args })
      return { stdout: '' }
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'task-compatibility-appraiser')!
    await setting.apply()

    const changeCall = calls.find(c => c.cmd === 'schtasks' && c.args[0] === '/change')
    expect(changeCall).toBeDefined()
    expect(changeCall!.args).toContain('/disable')
  })

  it('revert calls schtasks /change /enable', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    setupExecFile((cmd, args) => {
      calls.push({ cmd, args })
      return { stdout: '' }
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'task-compatibility-appraiser')!
    await setting.revert!()

    const changeCall = calls.find(c => c.cmd === 'schtasks' && c.args[0] === '/change')
    expect(changeCall).toBeDefined()
    expect(changeCall!.args).toContain('/enable')
  })

  it('applicable returns true when schtasks query succeeds', async () => {
    setupExecFile((cmd) => {
      if (cmd === 'schtasks') return { stdout: 'task info' }
      return { stdout: '' }
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'task-compatibility-appraiser')!
    expect(await setting.applicable!()).toBe(true)
  })

  it('applicable returns false when schtasks query throws', async () => {
    setupExecFileReject()

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'task-compatibility-appraiser')!
    expect(await setting.applicable!()).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
// SERVICE STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

describe('service state management', () => {
  it('check returns false when service is enabled (Start != 4)', async () => {
    setupExecFile((_cmd, args) => {
      if (args[0] === 'query' && (args[1] as string).includes('DiagTrack') && args[3] === 'Start') {
        return { stdout: '    Start    REG_DWORD    0x2' }
      }
      return { stdout: '' }
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'service-diagtrack')!
    expect(await setting.check()).toBe(false) // !(isServiceEnabled=true) = false
  })

  it('check returns true when service is disabled (Start = 4)', async () => {
    setupExecFile((_cmd, args) => {
      if (args[0] === 'query' && (args[1] as string).includes('DiagTrack') && args[3] === 'Start') {
        return { stdout: '    Start    REG_DWORD    0x4' }
      }
      return { stdout: '' }
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'service-diagtrack')!
    expect(await setting.check()).toBe(true)
  })

  it('disableService sets Start to 4 via reg add', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    setupExecFile((cmd, args) => {
      calls.push({ cmd, args })
      if (args[0] === 'query' && args[3] === 'Start') {
        return { stdout: '    Start    REG_DWORD    0x2' }
      }
      return { stdout: '' }
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'service-diagtrack')!
    await setting.apply()

    const addCall = calls.find(c => c.args[0] === 'add' && (c.args[1] as string).includes('DiagTrack'))
    expect(addCall).toBeDefined()
    expect(addCall!.args).toContain('4') // disabled = 4
  })

  it('enableService restores original start type via reg add', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    setupExecFile((cmd, args) => {
      calls.push({ cmd, args })
      return { stdout: '' }
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'service-diagtrack')!
    await setting.revert!()

    // Restores original Start value (cached from prior disableService, or defaults to 3)
    const addCall = calls.find(c => c.args[0] === 'add' && (c.args[1] as string).includes('DiagTrack'))
    expect(addCall).toBeDefined()
    // Value should be a numeric string (either cached original or default '3')
    const dataIdx = addCall!.args.indexOf('/d')
    const dataVal = addCall!.args[dataIdx + 1]
    expect(Number(dataVal)).toBeGreaterThanOrEqual(1)
    expect(Number(dataVal)).toBeLessThanOrEqual(4)
  })

  it('serviceExists returns true when Start value is found', async () => {
    setupExecFile((_cmd, args) => {
      if (args[0] === 'query' && args[3] === 'Start') {
        return { stdout: '    Start    REG_DWORD    0x3' }
      }
      return { stdout: '' }
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'service-diagtrack')!
    expect(await setting.applicable!()).toBe(true)
  })

  it('serviceExists returns false when Start value is absent', async () => {
    setupExecFileReject()

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'service-diagtrack')!
    expect(await setting.applicable!()).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
// BROWSER-CONDITIONAL SETTINGS
// ═══════════════════════════════════════════════════════════════════

describe('browser-conditional settings', () => {
  it('chrome check returns true when Chrome is not installed', async () => {
    setupExecFile((_cmd, args) => {
      if (args[0] === 'query' && (args[1] as string).includes('chrome.exe')) {
        throw new Error('not found')
      }
      return { stdout: '' }
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'chrome-metrics')!
    expect(await setting.check()).toBe(true)
  })

  it('chrome applicable returns false when Chrome is not installed', async () => {
    setupExecFileReject()

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'chrome-metrics')!
    expect(await setting.applicable!()).toBe(false)
  })

  it('firefox check returns true when Firefox is not installed', async () => {
    setupExecFile((_cmd, args) => {
      if (args[0] === 'query' && (args[1] as string).includes('firefox.exe')) {
        throw new Error('not found')
      }
      return { stdout: '' }
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'firefox-telemetry')!
    expect(await setting.check()).toBe(true)
  })

  it('chrome check returns false when installed but policy not set', async () => {
    setupExecFile((_cmd, args) => {
      // Browser installed
      if (args[0] === 'query' && (args[1] as string).includes('chrome.exe')) {
        return { stdout: '(Default)    REG_SZ    C:\\chrome.exe' }
      }
      // Policy not set — throws
      throw new Error('not found')
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'chrome-metrics')!
    expect(await setting.check()).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
// scanPrivacy
// ═══════════════════════════════════════════════════════════════════

describe('scanPrivacy', () => {
  it('returns PrivacyShieldState with correct structure', async () => {
    setupExecFileReject()

    const result = await scanPrivacy()

    expect(result).toHaveProperty('settings')
    expect(result).toHaveProperty('score')
    expect(result).toHaveProperty('total')
    expect(result).toHaveProperty('protected')
    expect(Array.isArray(result.settings)).toBe(true)
    expect(typeof result.score).toBe('number')
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
    expect(result.total).toBe(result.settings.length)
  })

  it('each setting has required PrivacySetting fields', async () => {
    setupExecFileReject()

    const result = await scanPrivacy()

    for (const s of result.settings) {
      expect(typeof s.id).toBe('string')
      expect(typeof s.category).toBe('string')
      expect(typeof s.label).toBe('string')
      expect(typeof s.description).toBe('string')
      expect(typeof s.enabled).toBe('boolean')
      expect(typeof s.reversible).toBe('boolean')
      expect(typeof s.requiresAdmin).toBe('boolean')
    }
  })

  it('protected count reflects settings that report enabled=true', async () => {
    // When all queries fail, some settings still return true:
    // - task checks: !(isTaskActive) where isTaskActive catches and returns false -> true
    // - browser checks: return true when browser not installed (catch -> false)
    // - service checks: !(isServiceEnabled) where isServiceEnabled returns false on error -> true
    setupExecFileReject()

    const result = await scanPrivacy()
    // protected count should equal the number of settings that report enabled=true
    expect(result.protected).toBe(result.settings.filter(s => s.enabled).length)
    expect(result.score).toBe(Math.round((result.protected / result.total) * 100))
  })

  it('calls onProgress callback for each setting', async () => {
    setupExecFileReject()

    const progressCalls: { current: number; total: number; currentLabel: string; category: string }[] = []
    await scanPrivacy((data) => progressCalls.push(data))

    expect(progressCalls.length).toBe(PRIVACY_SETTINGS.length)
    expect(progressCalls[0].current).toBe(1)
    expect(progressCalls[progressCalls.length - 1].current).toBe(PRIVACY_SETTINGS.length)
    expect(progressCalls[0].total).toBe(PRIVACY_SETTINGS.length)
  })

  it('progress includes label and category', async () => {
    setupExecFileReject()

    const progressCalls: { currentLabel: string; category: string }[] = []
    await scanPrivacy((data) => progressCalls.push(data))

    expect(progressCalls[0].currentLabel).toBe(PRIVACY_SETTINGS[0].label)
    expect(progressCalls[0].category).toBe(PRIVACY_SETTINGS[0].category)
  })

  it('works when onProgress is not provided', async () => {
    setupExecFileReject()
    const result = await scanPrivacy()
    expect(result.total).toBe(PRIVACY_SETTINGS.length)
  })

  it('catches errors in check() gracefully without crashing', async () => {
    setupExecFileReject()

    const result = await scanPrivacy()
    // All settings should resolve to a boolean (not throw)
    for (const s of result.settings) {
      expect(typeof s.enabled).toBe('boolean')
    }
    // Registry-based checks that compare val === 0 will get null (error) and return false
    const telemetry = result.settings.find(s => s.id === 'telemetry-level')!
    expect(telemetry.enabled).toBe(false)
  })

  it('sets reversible=false for settings without revert function', async () => {
    setupExecFileReject()
    const result = await scanPrivacy()
    for (const s of result.settings) {
      const def = PRIVACY_SETTINGS.find(d => d.id === s.id)!
      if (!def.revert) {
        expect(s.reversible).toBe(false)
      }
    }
  })

  it('sets reversible=false when applicable() returns false', async () => {
    setupExecFileReject() // all queries fail -> serviceExists/taskExists return false

    const result = await scanPrivacy()
    const settingsWithApplicable = result.settings.filter(s =>
      PRIVACY_SETTINGS.find(d => d.id === s.id)?.applicable !== undefined
    )
    for (const s of settingsWithApplicable) {
      expect(s.reversible).toBe(false)
    }
  })

  it('includes dependsOn field when defined', async () => {
    setupExecFileReject()
    const result = await scanPrivacy()

    for (const s of result.settings) {
      const def = PRIVACY_SETTINGS.find(d => d.id === s.id)!
      if (def.dependsOn) {
        expect((s as any).dependsOn).toBe(def.dependsOn)
      }
    }
  })

  it('total equals the number of settings processed', async () => {
    setupExecFileReject()
    const result = await scanPrivacy()
    expect(result.total).toBe(PRIVACY_SETTINGS.length)
    expect(result.settings.length).toBe(PRIVACY_SETTINGS.length)
  })
})

// ═══════════════════════════════════════════════════════════════════
// TIMEOUT BEHAVIOR
// ═══════════════════════════════════════════════════════════════════

describe('timeout behavior (withTimeout)', () => {
  it('returns fallback when promise never resolves', async () => {
    // Test the withTimeout pattern directly
    const neverResolves = new Promise<boolean>(() => {})
    const result = await Promise.race([
      neverResolves,
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50))
    ])
    expect(result).toBe(false)
  })

  it('returns actual value when promise resolves before timeout', async () => {
    const quickResolve = Promise.resolve(true)
    const result = await Promise.race([
      quickResolve,
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50))
    ])
    expect(result).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// applyPrivacySettings
// ═══════════════════════════════════════════════════════════════════

describe('applyPrivacySettings', () => {
  it('returns success count for valid IDs', async () => {
    setupExecFile(() => ({ stdout: '' }))

    const result = await applyPrivacySettings(['telemetry-level', 'advertising-id'])
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('skips unknown setting IDs silently', async () => {
    setupExecFile(() => ({ stdout: '' }))

    const result = await applyPrivacySettings(['nonexistent-id', 'telemetry-level'])
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(0)
  })

  it('reports failures with error details', async () => {
    setupExecFileReject(new Error('Access denied'))

    const result = await applyPrivacySettings(['telemetry-level'])
    expect(result.failed).toBe(1)
    expect(result.succeeded).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].id).toBe('telemetry-level')
    expect(result.errors[0].label).toBe('Windows Telemetry')
    expect(result.errors[0].reason).toBe('Access denied')
  })

  it('handles mixed success and failure', async () => {
    let callCount = 0
    execFileAsyncMock.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve({ stdout: '', stderr: '' })
      return Promise.reject(new Error('Permission denied'))
    })

    const result = await applyPrivacySettings(['feedback-frequency', 'telemetry-level'])
    expect(result.succeeded + result.failed).toBe(2)
  })

  it('returns empty result for empty array', async () => {
    const result = await applyPrivacySettings([])
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('handles non-Error thrown objects gracefully', async () => {
    execFileAsyncMock.mockRejectedValue('string error')

    const result = await applyPrivacySettings(['telemetry-level'])
    expect(result.failed).toBe(1)
    expect(result.errors[0].reason).toBe('Unknown error')
  })

  it('processes all IDs even if some fail', async () => {
    let callCount = 0
    execFileAsyncMock.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error('fail'))
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const result = await applyPrivacySettings(['telemetry-level', 'advertising-id'])
    expect(result.succeeded + result.failed).toBe(2)
  })

  it('handles duplicate IDs (applies each occurrence)', async () => {
    setupExecFile(() => ({ stdout: '' }))

    const result = await applyPrivacySettings(['telemetry-level', 'telemetry-level'])
    expect(result.succeeded).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════
// revertPrivacySettings
// ═══════════════════════════════════════════════════════════════════

describe('revertPrivacySettings', () => {
  it('returns success count for valid IDs with revert', async () => {
    setupExecFile(() => ({ stdout: '' }))

    const result = await revertPrivacySettings(['telemetry-level', 'advertising-id'])
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)
  })

  it('reports failure for unknown setting IDs', async () => {
    const result = await revertPrivacySettings(['nonexistent-setting'])
    expect(result.failed).toBe(1)
    expect(result.errors[0].reason).toBe('Revert not supported for this setting')
    expect(result.errors[0].id).toBe('nonexistent-setting')
    expect(result.errors[0].label).toBe('nonexistent-setting') // uses id as label fallback
  })

  it('reports failure when revert throws', async () => {
    execFileAsyncMock.mockRejectedValue(new Error('Cannot revert: access denied'))

    const result = await revertPrivacySettings(['telemetry-level'])
    expect(result.failed).toBe(1)
    expect(result.errors[0].reason).toBe('Cannot revert: access denied')
  })

  it('returns empty result for empty array', async () => {
    const result = await revertPrivacySettings([])
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('handles non-Error thrown objects in revert', async () => {
    execFileAsyncMock.mockRejectedValue(42)

    const result = await revertPrivacySettings(['telemetry-level'])
    expect(result.failed).toBe(1)
    expect(result.errors[0].reason).toBe('Unknown error')
  })

  it('processes all IDs even if some fail', async () => {
    let callCount = 0
    execFileAsyncMock.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error('fail'))
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const result = await revertPrivacySettings(['telemetry-level', 'advertising-id'])
    expect(result.succeeded + result.failed).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════
// INPUT VALIDATION
// ═══════════════════════════════════════════════════════════════════

describe('input validation via IPC handlers', () => {
  it('PRIVACY_APPLY returns empty result when validation fails', async () => {
    const mockValidate = vi.mocked(validateStringArray)
    mockValidate.mockReturnValueOnce(null)

    registerPrivacyShieldIpc(() => null)

    const handlers = (ipcMain as any)._handlers as Map<string, (...args: unknown[]) => unknown>
    const applyHandler = handlers.get(IPC.PRIVACY_APPLY)!

    const result = await applyHandler({}, 'not an array')
    expect(result).toEqual({ succeeded: 0, failed: 0, errors: [] })
  })

  it('PRIVACY_REVERT returns empty result when validation fails', async () => {
    const mockValidate = vi.mocked(validateStringArray)
    mockValidate.mockReturnValueOnce(null)

    registerPrivacyShieldIpc(() => null)

    const handlers = (ipcMain as any)._handlers as Map<string, (...args: unknown[]) => unknown>
    const revertHandler = handlers.get(IPC.PRIVACY_REVERT)!

    const result = await revertHandler({}, { not: 'an array' })
    expect(result).toEqual({ succeeded: 0, failed: 0, errors: [] })
  })

  it('PRIVACY_APPLY passes maxItems=1000 to validateStringArray', async () => {
    const mockValidate = vi.mocked(validateStringArray)
    mockValidate.mockClear()
    mockValidate.mockReturnValueOnce(['telemetry-level'])

    setupExecFile(() => ({ stdout: '' }))
    registerPrivacyShieldIpc(() => null)

    const handlers = (ipcMain as any)._handlers as Map<string, (...args: unknown[]) => unknown>
    await handlers.get(IPC.PRIVACY_APPLY)!({}, ['telemetry-level'])

    expect(mockValidate).toHaveBeenCalledWith(['telemetry-level'], 1_000)
  })

  it('PRIVACY_REVERT passes maxItems=1000 to validateStringArray', async () => {
    const mockValidate = vi.mocked(validateStringArray)
    mockValidate.mockClear()
    mockValidate.mockReturnValueOnce(['advertising-id'])

    setupExecFile(() => ({ stdout: '' }))
    registerPrivacyShieldIpc(() => null)

    const handlers = (ipcMain as any)._handlers as Map<string, (...args: unknown[]) => unknown>
    await handlers.get(IPC.PRIVACY_REVERT)!({}, ['advertising-id'])

    expect(mockValidate).toHaveBeenCalledWith(['advertising-id'], 1_000)
  })
})

// ═══════════════════════════════════════════════════════════════════
// IPC HANDLER REGISTRATION
// ═══════════════════════════════════════════════════════════════════

describe('registerPrivacyShieldIpc', () => {
  it('registers all three IPC handlers', () => {
    const handleSpy = vi.mocked(ipcMain.handle)
    handleSpy.mockClear()

    registerPrivacyShieldIpc(() => null)

    const channels = handleSpy.mock.calls.map(c => c[0])
    expect(channels).toContain(IPC.PRIVACY_SCAN)
    expect(channels).toContain(IPC.PRIVACY_APPLY)
    expect(channels).toContain(IPC.PRIVACY_REVERT)
  })

  it('PRIVACY_SCAN handler returns PrivacyShieldState', async () => {
    setupExecFileReject()

    registerPrivacyShieldIpc(() => null)

    const handlers = (ipcMain as any)._handlers as Map<string, (...args: unknown[]) => unknown>
    const result = await handlers.get(IPC.PRIVACY_SCAN)!() as any

    expect(result).toHaveProperty('settings')
    expect(result).toHaveProperty('score')
    expect(result).toHaveProperty('total')
    expect(result).toHaveProperty('protected')
  })

  it('PRIVACY_APPLY handler calls applyPrivacySettings with validated input', async () => {
    setupExecFile(() => ({ stdout: '' }))

    const mockValidate = vi.mocked(validateStringArray)
    mockValidate.mockClear()
    mockValidate.mockReturnValueOnce(['telemetry-level'])

    registerPrivacyShieldIpc(() => null)

    const handlers = (ipcMain as any)._handlers as Map<string, (...args: unknown[]) => unknown>
    const result = await handlers.get(IPC.PRIVACY_APPLY)!({}, ['telemetry-level']) as any

    expect(result.succeeded).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════
// SEND PROGRESS
// ═══════════════════════════════════════════════════════════════════

describe('sendProgress', () => {
  it('sends progress to window when window exists and is not destroyed', async () => {
    const sendMock = vi.fn()
    const mockWindow = {
      isDestroyed: () => false,
      webContents: { send: sendMock }
    }

    setupExecFileReject()

    registerPrivacyShieldIpc(() => mockWindow as any)

    const handlers = (ipcMain as any)._handlers as Map<string, (...args: unknown[]) => unknown>
    await handlers.get(IPC.PRIVACY_SCAN)!()

    expect(sendMock).toHaveBeenCalled()
    const [channel, data] = sendMock.mock.calls[0]
    expect(channel).toBe(IPC.PRIVACY_PROGRESS)
    expect(data).toHaveProperty('current')
    expect(data).toHaveProperty('total')
    expect(data).toHaveProperty('currentLabel')
    expect(data).toHaveProperty('category')
  })

  it('does not throw when window is null', async () => {
    setupExecFileReject()

    registerPrivacyShieldIpc(() => null)

    const handlers = (ipcMain as any)._handlers as Map<string, (...args: unknown[]) => unknown>
    await handlers.get(IPC.PRIVACY_SCAN)!()
    // no throw = pass
  })

  it('does not send when window is destroyed', async () => {
    const sendMock = vi.fn()
    const mockWindow = {
      isDestroyed: () => true,
      webContents: { send: sendMock }
    }

    setupExecFileReject()

    registerPrivacyShieldIpc(() => mockWindow as any)

    const handlers = (ipcMain as any)._handlers as Map<string, (...args: unknown[]) => unknown>
    await handlers.get(IPC.PRIVACY_SCAN)!()

    expect(sendMock).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES AND ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════

describe('edge cases and error handling', () => {
  it('regQueryDword handles malformed stdout gracefully', async () => {
    setupExecFile(() => ({ stdout: 'garbage output without REG_DWORD' }))

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'telemetry-level')!
    expect(await setting.check()).toBe(false) // regex won't match -> null -> false
  })

  it('regQueryDword handles uppercase hex values', async () => {
    setupExecFile((_cmd, args) => {
      if (args[0] === 'query') {
        return { stdout: '    AllowTelemetry    REG_DWORD    0x0000000A' }
      }
      return { stdout: '' }
    })

    const setting = PRIVACY_SETTINGS.find(s => s.id === 'telemetry-level')!
    expect(await setting.check()).toBe(false) // 0xA = 10, not 0
  })

  it('handles extremely long setting ID lists (all unknown)', async () => {
    setupExecFile(() => ({ stdout: '' }))

    const ids = Array.from({ length: 500 }, (_, i) => `unknown-${i}`)
    const result = await applyPrivacySettings(ids)
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
// IPC CHANNEL FORMAT
// ═══════════════════════════════════════════════════════════════════

describe('IPC channel format', () => {
  it('uses correct channel names from IPC constants', () => {
    expect(IPC.PRIVACY_SCAN).toBe('privacy:scan')
    expect(IPC.PRIVACY_APPLY).toBe('privacy:apply')
    expect(IPC.PRIVACY_REVERT).toBe('privacy:revert')
    expect(IPC.PRIVACY_PROGRESS).toBe('privacy:progress')
  })
})
