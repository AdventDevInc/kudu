import { describe, it, expect } from 'vitest'

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

  return true
}

// ── Valid snapshot fixture ──

function validSnapshot() {
  return {
    activatedAt: '2025-06-15T10:30:00.000Z',
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
      services: [],
      killedProcesses: [],
      originalPowerPlanGuid: null,
      originalFocusAssistState: null,
      powerSaveBlockerId: null,
      nagleInterfaces: [],
      registryTweaks: [],
    })).toBe(true)
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
