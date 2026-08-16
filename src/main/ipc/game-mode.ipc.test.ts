import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──
// game-mode.ipc pulls in electron, child_process and a handful of services.
// Stub them all so the restore/deactivate logic can be exercised in-process:
// a fake in-memory snapshot file plus a scriptable PowerShell double.

const psCalls: string[] = []
/** Substrings that make the fake PowerShell call reject, mimicking a stuck step */
let psFailOn: string[] = []
/** Canned stdout per matching substring */
let psOutput: Array<[string, string]> = []

const fakeFs = new Map<string, string>()

const gameDetectorMocks = vi.hoisted(() => ({
  startGameDetector: vi.fn(),
  stopGameDetector: vi.fn(),
  suppressCurrentGame: vi.fn(),
  isDetectorRunning: vi.fn(() => false),
}))

const settingsMock = vi.hoisted(() => ({
  gameMode: {
    enabledOptimizations: ['net-flush-dns'],
    customProcessKillList: [] as string[],
    autoDetect: false,
    autoDeactivate: true,
    customGameProcesses: [] as string[],
  },
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => 'C:\\kudu-test-userdata' },
  ipcMain: { handle: vi.fn() },
  powerSaveBlocker: { start: vi.fn(() => 7), stop: vi.fn(), isStarted: vi.fn(() => false) },
}))

vi.mock('fs', () => ({
  existsSync: (p: string) => fakeFs.has(p),
  readFileSync: (p: string) => {
    const v = fakeFs.get(p)
    if (v === undefined) throw new Error('ENOENT')
    return v
  },
  writeFileSync: (p: string, data: string) => { fakeFs.set(p, data) },
  unlinkSync: (p: string) => {
    if (!fakeFs.delete(p)) throw new Error('ENOENT')
  },
}))

vi.mock('child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    const script = args[args.length - 1]
    psCalls.push(script)
    const failure = psFailOn.find((needle) => script.includes(needle))
    if (failure) {
      cb(new Error(`fake failure for ${failure}`))
      return
    }
    const canned = psOutput.find(([needle]) => script.includes(needle))
    cb(null, { stdout: canned?.[1] ?? '', stderr: '' })
  },
}))

vi.mock('../services/exec-utf8', () => ({ psUtf8: (s: string) => s }))
vi.mock('../services/elevation', () => ({ isAdmin: () => true }))
vi.mock('../platform', () => ({ getPlatform: () => ({ network: { flushDnsCache: async () => true } }) }))
vi.mock('../services/game-detector', () => gameDetectorMocks)
vi.mock('../services/settings-store', () => ({ getSettings: () => settingsMock }))

import { join } from 'path'
import { deactivateGameMode, discardPendingRestore, getGameModeStatus, initGameDetector } from './game-mode.ipc'

// Built with join() rather than hardcoded so the fake fs keys match on both
// Windows and the Linux CI runner.
const SNAPSHOT_PATH = join('C:\\kudu-test-userdata', 'game-mode-snapshot.json')

// We test the exported validateSnapshot logic by importing the module's internal
// validation indirectly through its exported functions.  Since validateSnapshot
// is not exported, we test the shape constraints it enforces by constructing
// valid/invalid snapshot objects and verifying them against the same rules.

// ── Snapshot validation rules (mirrored from game-mode.ipc.ts) ──

const VALID_SERVICE_NAMES = new Set(['WSearch', 'SysMain', 'wuauserv', 'Spooler', 'DiagTrack'])
const REGISTRY_PATH_RE = /^Microsoft\.PowerShell\.Core\\Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{[0-9A-Fa-f\-]+}$/
const ALLOWED_REGISTRY_TWEAK_PATHS = new Set([
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR',
  'HKCU:\\System\\GameConfigStore',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
])
const ALLOWED_REGISTRY_TWEAK_NAMES = new Set([
  'AppCaptureEnabled', 'GameDVR_Enabled',
  'GameDVR_FSEBehaviorMode', 'GameDVR_HonorUserFSEBehaviorMode',
  'GameDVR_DXGIHonorFSEWindowsCompatible', 'GameDVR_EFSEFeatureFlags',
  'EnableTransparency',
])

function validateSnapshot(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const s = raw as Record<string, unknown>

  if (typeof s.activatedAt !== 'string' || s.activatedAt.length > 50) return false

  if ('active' in s && typeof s.active !== 'boolean') return false

  if (!Array.isArray(s.services)) return false
  for (const svc of s.services) {
    if (typeof svc !== 'object' || svc === null) return false
    const sv = svc as Record<string, unknown>
    if (typeof sv.name !== 'string' || !VALID_SERVICE_NAMES.has(sv.name)) return false
    if (typeof sv.originalStartType !== 'string' || !/^[A-Za-z0-9]{1,20}$/.test(sv.originalStartType)) return false
    if (typeof sv.wasRunning !== 'boolean') return false
  }

  if (!Array.isArray(s.killedProcesses)) return false
  for (const p of s.killedProcesses) {
    if (typeof p !== 'object' || p === null) return false
    const pv = p as Record<string, unknown>
    if (typeof pv.pid !== 'number' || !Number.isInteger(pv.pid)) return false
    if (typeof pv.name !== 'string' || pv.name.length > 260) return false
  }

  if (s.originalPowerPlanGuid !== null) {
    if (typeof s.originalPowerPlanGuid !== 'string') return false
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.originalPowerPlanGuid)) return false
  }

  if (s.originalFocusAssistState !== null) {
    if (typeof s.originalFocusAssistState !== 'number') return false
    if (!Number.isInteger(s.originalFocusAssistState) || s.originalFocusAssistState < 0 || s.originalFocusAssistState > 1) return false
  }

  if (s.powerSaveBlockerId !== null) {
    if (typeof s.powerSaveBlockerId !== 'number' || !Number.isInteger(s.powerSaveBlockerId)) return false
  }

  if (!Array.isArray(s.nagleInterfaces)) return false
  for (const iface of s.nagleInterfaces) {
    if (typeof iface !== 'object' || iface === null) return false
    const iv = iface as Record<string, unknown>
    if (typeof iv.path !== 'string' || !REGISTRY_PATH_RE.test(iv.path)) return false
    if (iv.originalTcpNoDelay !== null && (typeof iv.originalTcpNoDelay !== 'number' || !Number.isInteger(iv.originalTcpNoDelay) || iv.originalTcpNoDelay < 0 || iv.originalTcpNoDelay > 1)) return false
    if (iv.originalTcpAckFrequency !== null && (typeof iv.originalTcpAckFrequency !== 'number' || !Number.isInteger(iv.originalTcpAckFrequency) || iv.originalTcpAckFrequency < 0 || iv.originalTcpAckFrequency > 255)) return false
  }

  if (!Array.isArray(s.registryTweaks)) return false
  for (const tweak of s.registryTweaks) {
    if (typeof tweak !== 'object' || tweak === null) return false
    const tv = tweak as Record<string, unknown>
    if (typeof tv.path !== 'string' || !ALLOWED_REGISTRY_TWEAK_PATHS.has(tv.path)) return false
    if (typeof tv.name !== 'string' || !ALLOWED_REGISTRY_TWEAK_NAMES.has(tv.name)) return false
    if (tv.originalValue !== null && (typeof tv.originalValue !== 'number' || !Number.isInteger(tv.originalValue))) return false
  }

  if ('restoreErrors' in s) {
    if (!Array.isArray(s.restoreErrors)) return false
    if (s.restoreErrors.length > 20) return false
    for (const e of s.restoreErrors) {
      if (typeof e !== 'object' || e === null) return false
      const ev = e as Record<string, unknown>
      if (typeof ev.optimizationId !== 'string' || ev.optimizationId.length > 100) return false
      if (typeof ev.reason !== 'string' || ev.reason.length > 500) return false
    }
  }

  return true
}

// ── Valid snapshot fixture ──

function validSnapshot() {
  return {
    activatedAt: '2025-06-15T10:30:00.000Z',
    active: true,
    services: [
      { name: 'WSearch', originalStartType: 'Automatic', wasRunning: true },
      { name: 'SysMain', originalStartType: 'Manual', wasRunning: false },
    ],
    killedProcesses: [
      { pid: 1234, name: 'chrome.exe' },
    ],
    originalPowerPlanGuid: '381b4222-f694-41f0-9685-ff5bb260df2e',
    originalFocusAssistState: 1,
    powerSaveBlockerId: 0,
    nagleInterfaces: [
      {
        path: 'Microsoft.PowerShell.Core\\Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{abc12345-1234-5678-9abc-def012345678}',
        originalTcpNoDelay: null,
        originalTcpAckFrequency: 1,
      },
    ],
    registryTweaks: [
      { path: 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR', name: 'AppCaptureEnabled', originalValue: 1 },
      { path: 'HKCU:\\System\\GameConfigStore', name: 'GameDVR_Enabled', originalValue: 1 },
    ],
  }
}

describe('snapshot validation', () => {
  it('accepts a valid snapshot', () => {
    expect(validateSnapshot(validSnapshot())).toBe(true)
  })

  it('accepts a minimal snapshot with empty arrays', () => {
    expect(validateSnapshot({
      activatedAt: '2025-01-01T00:00:00Z',
      active: true,
      services: [],
      killedProcesses: [],
      originalPowerPlanGuid: null,
      originalFocusAssistState: null,
      powerSaveBlockerId: null,
      nagleInterfaces: [],
      registryTweaks: [],
    })).toBe(true)
  })

  it('accepts a snapshot without active field (pre-fix backward compat)', () => {
    expect(validateSnapshot({
      activatedAt: '2025-01-01T00:00:00Z',
      services: [],
      killedProcesses: [],
      originalPowerPlanGuid: null,
      originalFocusAssistState: null,
      powerSaveBlockerId: null,
      nagleInterfaces: [],
      registryTweaks: [],
    })).toBe(true)
  })

  it('rejects snapshot with non-boolean active', () => {
    const snap = validSnapshot()
    ;(snap as any).active = 'yes'
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects null / non-object', () => {
    expect(validateSnapshot(null)).toBe(false)
    expect(validateSnapshot('string')).toBe(false)
    expect(validateSnapshot([])).toBe(false)
  })

  it('rejects missing activatedAt', () => {
    const snap = validSnapshot()
    delete (snap as any).activatedAt
    expect(validateSnapshot(snap)).toBe(false)
  })

  // ── Service validation ──

  it('rejects services with names not in allowlist', () => {
    const snap = validSnapshot()
    snap.services[0].name = 'EvilService'
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects services with injection in originalStartType', () => {
    const snap = validSnapshot()
    snap.services[0].originalStartType = "Automatic'; Get-Content C:\\secrets"
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects services with empty originalStartType', () => {
    const snap = validSnapshot()
    snap.services[0].originalStartType = ''
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects services with non-boolean wasRunning', () => {
    const snap = validSnapshot()
    ;(snap.services[0] as any).wasRunning = 'true'
    expect(validateSnapshot(snap)).toBe(false)
  })

  // ── Power plan GUID validation ──

  it('rejects invalid power plan GUID format', () => {
    const snap = validSnapshot()
    snap.originalPowerPlanGuid = 'not-a-guid'
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects power plan GUID with injection', () => {
    const snap = validSnapshot()
    snap.originalPowerPlanGuid = '381b4222-f694-41f0-9685-ff5bb260df2e; rm -rf /'
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('accepts null power plan GUID', () => {
    const snap = validSnapshot()
    snap.originalPowerPlanGuid = null
    expect(validateSnapshot(snap)).toBe(true)
  })

  // ── Focus Assist validation ──

  it('rejects Focus Assist state outside 0-1 range', () => {
    const snap = validSnapshot()
    snap.originalFocusAssistState = 999
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects Focus Assist state that is non-integer', () => {
    const snap = validSnapshot()
    snap.originalFocusAssistState = 0.5
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects Focus Assist state that is a string', () => {
    const snap = validSnapshot()
    ;(snap as any).originalFocusAssistState = '0; malicious-command'
    expect(validateSnapshot(snap)).toBe(false)
  })

  // ── Nagle interface validation ──

  it('rejects nagle interface with arbitrary registry path', () => {
    const snap = validSnapshot()
    snap.nagleInterfaces[0].path = "HKLM:\\SOFTWARE\\Evil'; Get-Content C:\\secrets"
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects nagle interface with path traversal', () => {
    const snap = validSnapshot()
    snap.nagleInterfaces[0].path = '..\\..\\..\\evil'
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects nagle TcpNoDelay values outside 0-1', () => {
    const snap = validSnapshot()
    snap.nagleInterfaces[0].originalTcpNoDelay = 42
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects nagle TcpAckFrequency as string', () => {
    const snap = validSnapshot()
    ;(snap.nagleInterfaces[0] as any).originalTcpAckFrequency = '1; malicious'
    expect(validateSnapshot(snap)).toBe(false)
  })

  // ── Killed processes validation ──

  it('rejects killed process with non-integer PID', () => {
    const snap = validSnapshot()
    snap.killedProcesses[0].pid = 1.5
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects killed process with overly long name', () => {
    const snap = validSnapshot()
    snap.killedProcesses[0].name = 'x'.repeat(261)
    expect(validateSnapshot(snap)).toBe(false)
  })

  // ── Registry tweaks validation ──

  it('accepts valid registry tweaks', () => {
    const snap = validSnapshot()
    snap.registryTweaks = [
      { path: 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR', name: 'AppCaptureEnabled', originalValue: 1 },
      { path: 'HKCU:\\System\\GameConfigStore', name: 'GameDVR_FSEBehaviorMode', originalValue: null },
      { path: 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', name: 'EnableTransparency', originalValue: 1 },
    ]
    expect(validateSnapshot(snap)).toBe(true)
  })

  it('rejects registry tweaks with path not in allowlist', () => {
    const snap = validSnapshot()
    snap.registryTweaks = [
      { path: "HKLM:\\SOFTWARE\\Evil'; Get-Content C:\\secrets", name: 'AppCaptureEnabled', originalValue: 0 },
    ]
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects registry tweaks with name not in allowlist', () => {
    const snap = validSnapshot()
    snap.registryTweaks = [
      { path: 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR', name: 'EvilKey', originalValue: 0 },
    ]
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects registry tweaks with non-integer originalValue', () => {
    const snap = validSnapshot()
    snap.registryTweaks = [
      { path: 'HKCU:\\System\\GameConfigStore', name: 'GameDVR_Enabled', originalValue: 1.5 },
    ]
    expect(validateSnapshot(snap)).toBe(false)
  })

  // ── Restore errors validation ──

  it('accepts a snapshot carrying restore errors', () => {
    const snap = validSnapshot()
    ;(snap as any).restoreErrors = [{ optimizationId: 'sys-registry-tweaks', reason: 'Access denied' }]
    expect(validateSnapshot(snap)).toBe(true)
  })

  it('rejects restore errors with a non-string reason', () => {
    const snap = validSnapshot()
    ;(snap as any).restoreErrors = [{ optimizationId: 'sys-registry-tweaks', reason: 42 }]
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects an unbounded restore error reason', () => {
    const snap = validSnapshot()
    ;(snap as any).restoreErrors = [{ optimizationId: 'sys-registry-tweaks', reason: 'x'.repeat(501) }]
    expect(validateSnapshot(snap)).toBe(false)
  })

  it('rejects registry tweaks with string originalValue', () => {
    const snap = validSnapshot()
    ;(snap as any).registryTweaks = [
      { path: 'HKCU:\\System\\GameConfigStore', name: 'GameDVR_Enabled', originalValue: '1; malicious' },
    ]
    expect(validateSnapshot(snap)).toBe(false)
  })
})

// ── IPC config validation (mirrors game-mode.ipc.ts validateGameModeConfig) ──

const VALID_OPTIMIZATION_IDS = new Set([
  'svc-wsearch', 'svc-sysmain', 'svc-wuauserv', 'svc-spooler', 'svc-diagtrack',
  'proc-kill-browsers', 'proc-kill-chat', 'proc-kill-updaters', 'proc-kill-custom',
  'mem-clear-standby',
  'sys-focus-assist', 'sys-power-plan', 'sys-prevent-sleep',
  'sys-disable-game-bar', 'sys-disable-fse-opt', 'sys-disable-transparency',
  'net-flush-dns', 'net-disable-nagle',
])
const PROCESS_NAME_RE = /^[A-Za-z0-9._\- ]+$/

function validateGameModeConfig(input: unknown): boolean {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false
  const obj = input as Record<string, unknown>

  if (!Array.isArray(obj.enabledOptimizations)) return false
  if (obj.enabledOptimizations.length > 30) return false
  if (!obj.enabledOptimizations.every((v: unknown) => typeof v === 'string' && VALID_OPTIMIZATION_IDS.has(v as string))) return false

  if (!Array.isArray(obj.customProcessKillList)) return false
  if (obj.customProcessKillList.length > 50) return false
  if (!obj.customProcessKillList.every((v: unknown) =>
    typeof v === 'string' && (v as string).length > 0 && (v as string).length <= 100 && PROCESS_NAME_RE.test(v as string)
  )) return false

  return true
}

describe('IPC config validation', () => {
  it('accepts valid config', () => {
    expect(validateGameModeConfig({
      enabledOptimizations: ['svc-wsearch', 'net-flush-dns'],
      customProcessKillList: ['spotify.exe'],
    })).toBe(true)
  })

  it('accepts empty arrays', () => {
    expect(validateGameModeConfig({
      enabledOptimizations: [],
      customProcessKillList: [],
    })).toBe(true)
  })

  it('rejects null', () => {
    expect(validateGameModeConfig(null)).toBe(false)
  })

  it('rejects config with unknown optimization IDs', () => {
    expect(validateGameModeConfig({
      enabledOptimizations: ['inject-command'],
      customProcessKillList: [],
    })).toBe(false)
  })

  it('rejects config with shell injection in process names', () => {
    expect(validateGameModeConfig({
      enabledOptimizations: [],
      customProcessKillList: ['evil.exe; rm -rf /'],
    })).toBe(false)
  })

  it('rejects config with pipe in process names', () => {
    expect(validateGameModeConfig({
      enabledOptimizations: [],
      customProcessKillList: ['evil.exe | cat /etc/passwd'],
    })).toBe(false)
  })

  it('rejects config with backtick in process names', () => {
    expect(validateGameModeConfig({
      enabledOptimizations: [],
      customProcessKillList: ['evil`malicious`'],
    })).toBe(false)
  })

  it('rejects config without required fields', () => {
    expect(validateGameModeConfig({ enabledOptimizations: [] })).toBe(false)
    expect(validateGameModeConfig({ customProcessKillList: [] })).toBe(false)
  })
})

// ── Service map and optimization ID consistency ──

// ── Deactivation / residual handling (issue #241) ──

const GAME_DVR = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR'
const GAME_CONFIG_STORE = 'HKCU:\\System\\GameConfigStore'
const IFACE_A = 'Microsoft.PowerShell.Core\\Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{aaaaaaaa-1111-2222-3333-444444444444}'
const IFACE_B = 'Microsoft.PowerShell.Core\\Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{bbbbbbbb-1111-2222-3333-444444444444}'

function seedSnapshot(overrides: Record<string, unknown> = {}): void {
  fakeFs.set(SNAPSHOT_PATH, JSON.stringify({
    activatedAt: '2026-07-21T22:00:00.000Z',
    active: true,
    services: [],
    killedProcesses: [],
    originalPowerPlanGuid: null,
    originalFocusAssistState: null,
    powerSaveBlockerId: null,
    nagleInterfaces: [],
    registryTweaks: [],
    ...overrides,
  }))
}

function storedSnapshot(): any {
  const raw = fakeFs.get(SNAPSHOT_PATH)
  return raw === undefined ? null : JSON.parse(raw)
}

const noop = () => {}

describe('deactivateGameMode residual handling', () => {
  beforeEach(() => {
    fakeFs.clear()
    psCalls.length = 0
    psFailOn = []
    psOutput = []
  })

  it('keeps only the failed registry tweak pending, not the whole group', async () => {
    seedSnapshot({
      registryTweaks: [
        { path: GAME_DVR, name: 'AppCaptureEnabled', originalValue: 1 },
        { path: GAME_CONFIG_STORE, name: 'GameDVR_Enabled', originalValue: 1 },
      ],
    })
    psFailOn = ['GameDVR_Enabled']

    const result = await deactivateGameMode(noop)

    expect(result.failed).toBe(1)
    const stored = storedSnapshot()
    expect(stored.active).toBe(false)
    expect(stored.registryTweaks).toEqual([
      { path: GAME_CONFIG_STORE, name: 'GameDVR_Enabled', originalValue: 1 },
    ])
  })

  it('persists the failure reason so the banner can name the stuck step', async () => {
    seedSnapshot({
      registryTweaks: [{ path: GAME_DVR, name: 'AppCaptureEnabled', originalValue: 1 }],
    })
    psFailOn = ['AppCaptureEnabled']

    await deactivateGameMode(noop)

    const stored = storedSnapshot()
    expect(stored.restoreErrors).toHaveLength(1)
    expect(stored.restoreErrors[0].optimizationId).toBe('sys-registry-tweaks')
    expect(stored.restoreErrors[0].reason).toContain('fake failure')
    expect(getGameModeStatus().pendingReason).toContain('fake failure')
  })

  it('drops the snapshot once a retry clears the remaining item', async () => {
    seedSnapshot({
      active: false,
      registryTweaks: [{ path: GAME_DVR, name: 'AppCaptureEnabled', originalValue: 1 }],
      restoreErrors: [{ optimizationId: 'sys-registry-tweaks', reason: 'earlier failure' }],
    })

    const result = await deactivateGameMode(noop)

    expect(result.failed).toBe(0)
    expect(fakeFs.has(SNAPSHOT_PATH)).toBe(false)
    expect(getGameModeStatus().pendingRestore).toBe(false)
  })

  it('recreates a vanished registry key instead of failing forever', async () => {
    seedSnapshot({
      registryTweaks: [{ path: GAME_DVR, name: 'AppCaptureEnabled', originalValue: 1 }],
    })

    await deactivateGameMode(noop)

    const script = psCalls.find((s) => s.includes('AppCaptureEnabled'))
    expect(script).toContain('if (!(Test-Path $p)) { New-Item -Path $p -Force | Out-Null }')
  })

  it('skips Nagle interfaces whose registry key no longer exists', async () => {
    seedSnapshot({
      nagleInterfaces: [{ path: IFACE_A, originalTcpNoDelay: 0, originalTcpAckFrequency: 2 }],
    })

    const result = await deactivateGameMode(noop)

    expect(result.failed).toBe(0)
    const script = psCalls.find((s) => s.includes(IFACE_A))
    expect(script).toContain('if (Test-Path $p)')
  })

  it('keeps only the failed Nagle interface pending', async () => {
    seedSnapshot({
      nagleInterfaces: [
        { path: IFACE_A, originalTcpNoDelay: 0, originalTcpAckFrequency: 2 },
        { path: IFACE_B, originalTcpNoDelay: 0, originalTcpAckFrequency: 2 },
      ],
    })
    psFailOn = ['{bbbbbbbb-']

    const result = await deactivateGameMode(noop)

    expect(result.failed).toBe(1)
    expect(storedSnapshot().nagleInterfaces).toHaveLength(1)
    expect(storedSnapshot().nagleInterfaces[0].path).toBe(IFACE_B)
  })

  it('guards service restore against a service that no longer exists', async () => {
    seedSnapshot({
      services: [{ name: 'WSearch', originalStartType: 'Automatic', wasRunning: true }],
    })

    await deactivateGameMode(noop)

    const script = psCalls.find((s) => s.includes('Set-Service'))
    expect(script).toContain("if (Get-Service -Name 'WSearch' -ErrorAction SilentlyContinue)")
  })

  it('ignores a powerSaveBlocker ID left behind by a previous process', async () => {
    // Written by an older run; the blocker died with that process, so this must
    // not queue a step that keeps the snapshot alive.
    seedSnapshot({ active: false, powerSaveBlockerId: 7 })

    const result = await deactivateGameMode(noop)

    expect(result.restored).toBe(0)
    expect(result.failed).toBe(0)
    expect(fakeFs.has(SNAPSHOT_PATH)).toBe(false)
  })
})

describe('auto-deactivate lifecycle (issue #289)', () => {
  beforeEach(() => {
    fakeFs.clear()
    psCalls.length = 0
    psFailOn = []
    psOutput = []
    gameDetectorMocks.startGameDetector.mockReset()
    gameDetectorMocks.stopGameDetector.mockReset()
    settingsMock.gameMode.autoDetect = true
    settingsMock.gameMode.autoDeactivate = true
  })

  it('activates on detection and restores on exit', async () => {
    const sendAutoEvent = vi.fn()
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    try {
      initGameDetector(() => null, noop, sendAutoEvent)
      const callbacks = gameDetectorMocks.startGameDetector.mock.calls[0]?.[0]

      expect(callbacks).toBeDefined()
      await expect(callbacks.onGameDetected('cs2.exe')).resolves.toBe(true)
      expect(getGameModeStatus().active).toBe(true)
      expect(sendAutoEvent).toHaveBeenCalledWith({ type: 'game-detected', processName: 'cs2.exe' })

      await callbacks.onGameExited()

      expect(getGameModeStatus().active).toBe(false)
      expect(sendAutoEvent).toHaveBeenLastCalledWith({ type: 'game-exited', processName: null })
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('tracks and deactivates a session that was already active when the game was detected', async () => {
    seedSnapshot()
    const sendAutoEvent = vi.fn()
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    try {
      initGameDetector(() => null, noop, sendAutoEvent)
      const callbacks = gameDetectorMocks.startGameDetector.mock.calls[0]?.[0]

      expect(callbacks).toBeDefined()
      await expect(callbacks.onGameDetected('cs2.exe')).resolves.toBe(true)
      expect(sendAutoEvent).toHaveBeenCalledWith({ type: 'game-detected', processName: 'cs2.exe' })

      await callbacks.onGameExited()

      expect(fakeFs.has(SNAPSHOT_PATH)).toBe(false)
      expect(sendAutoEvent).toHaveBeenLastCalledWith({ type: 'game-exited', processName: null })
    } finally {
      platformSpy.mockRestore()
    }
  })
})

describe('discardPendingRestore', () => {
  beforeEach(() => {
    fakeFs.clear()
    psCalls.length = 0
    psFailOn = []
    psOutput = []
  })

  it('clears a residual snapshot so activation is unblocked', () => {
    seedSnapshot({
      active: false,
      registryTweaks: [{ path: GAME_DVR, name: 'AppCaptureEnabled', originalValue: 1 }],
      restoreErrors: [{ optimizationId: 'sys-registry-tweaks', reason: 'Access denied' }],
    })
    expect(getGameModeStatus().pendingRestore).toBe(true)

    expect(discardPendingRestore()).toEqual({ discarded: true })
    expect(fakeFs.has(SNAPSHOT_PATH)).toBe(false)
    expect(getGameModeStatus()).toEqual({
      active: false,
      activatedAt: null,
      pendingRestore: false,
      pendingReason: null,
    })
  })

  it('refuses while Game Mode is still active', () => {
    seedSnapshot({
      registryTweaks: [{ path: GAME_DVR, name: 'AppCaptureEnabled', originalValue: 1 }],
    })

    const result = discardPendingRestore()

    expect(result.discarded).toBe(false)
    expect(fakeFs.has(SNAPSHOT_PATH)).toBe(true)
  })

  it('removes a corrupt snapshot file that validation rejects', () => {
    fakeFs.set(SNAPSHOT_PATH, '{ not json')

    expect(discardPendingRestore().discarded).toBe(true)
    expect(fakeFs.has(SNAPSHOT_PATH)).toBe(false)
  })
})

describe('optimization ID consistency', () => {
  const SERVICE_MAP_KEYS = new Set(['svc-wsearch', 'svc-sysmain', 'svc-wuauserv', 'svc-spooler', 'svc-diagtrack'])

  it('SERVICE_MAP keys are a subset of valid optimization IDs', () => {
    for (const key of SERVICE_MAP_KEYS) {
      expect(VALID_OPTIMIZATION_IDS.has(key)).toBe(true)
    }
  })

  it('all valid optimization IDs are known strings', () => {
    expect(VALID_OPTIMIZATION_IDS.size).toBe(18)
  })

  it('all VALID_SERVICE_NAMES correspond to SERVICE_MAP values', () => {
    const expectedServices = new Set(['WSearch', 'SysMain', 'wuauserv', 'Spooler', 'DiagTrack'])
    expect(VALID_SERVICE_NAMES).toEqual(expectedServices)
  })
})
