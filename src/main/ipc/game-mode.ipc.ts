import { app, ipcMain, powerSaveBlocker } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { IPC } from '../../shared/channels'
import { isAdmin } from '../services/elevation'
import { getPlatform } from '../platform'
import type { WindowGetter } from './index'
import { psUtf8 } from '../services/exec-utf8'
import type {
  GameModeConfig,
  GameModeSnapshot,
  GameModeActivateResult,
  GameModeDeactivateResult,
  GameModeProgress,
  GameModeStatus,
  GameModeOptimizationId,
} from '../../shared/types'
import type { GameAutoEvent } from '../services/game-detector'
import {
  startGameDetector,
  stopGameDetector,
  suppressCurrentGame,
  isDetectorRunning,
} from '../services/game-detector'
import { getSettings } from '../services/settings-store'

const execFileAsync = promisify(execFile)

// ── Service name allowlist ───────────────────────────────────

const SERVICE_MAP: Record<string, string> = {
  'svc-wsearch': 'WSearch',
  'svc-sysmain': 'SysMain',
  'svc-wuauserv': 'wuauserv',
  'svc-spooler': 'Spooler',
  'svc-diagtrack': 'DiagTrack',
}

// ── Snapshot persistence ─────────────────────────────────────

function getSnapshotPath(): string {
  const dir = app.isPackaged
    ? app.getPath('userData')
    : join(app.getPath('userData'), 'Kudu-Dev')
  return join(dir, 'game-mode-snapshot.json')
}

// Allowlist of service names we ever write to the snapshot — used to validate on read-back
const VALID_SERVICE_NAMES = new Set(Object.values(SERVICE_MAP))

// Allowlist of registry paths and value names for registry tweaks — prevents snapshot tampering
const ALLOWED_REGISTRY_TWEAK_PATHS = new Set([
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR',
  'HKCU:\\System\\GameConfigStore',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
])
const ALLOWED_REGISTRY_TWEAK_NAMES = new Set([
  'AppCaptureEnabled',
  'GameDVR_Enabled',
  'GameDVR_FSEBehaviorMode',
  'GameDVR_HonorUserFSEBehaviorMode',
  'GameDVR_DXGIHonorFSEWindowsCompatible',
  'GameDVR_EFSEFeatureFlags',
  'EnableTransparency',
])

/** Validate and sanitize a snapshot read from disk to prevent injection via file tampering */
function validateSnapshot(raw: unknown): GameModeSnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const s = raw as Record<string, unknown>

  if (typeof s.activatedAt !== 'string' || s.activatedAt.length > 50) return null

  // `active` is optional for backward compat: snapshots written before this
  // field was introduced came from a live Game Mode session, so absence means true.
  if ('active' in s && typeof s.active !== 'boolean') return null
  if (!('active' in s)) s.active = true

  // Validate services array — only accept names from our allowlist
  if (!Array.isArray(s.services)) return null
  for (const svc of s.services) {
    if (typeof svc !== 'object' || svc === null) return null
    const sv = svc as Record<string, unknown>
    if (typeof sv.name !== 'string' || !VALID_SERVICE_NAMES.has(sv.name)) return null
    if (typeof sv.originalStartType !== 'string' || !/^[A-Za-z0-9]{1,20}$/.test(sv.originalStartType)) return null
    if (typeof sv.wasRunning !== 'boolean') return null
  }

  // Validate killedProcesses — informational only, but still sanitize
  if (!Array.isArray(s.killedProcesses)) return null
  for (const p of s.killedProcesses) {
    if (typeof p !== 'object' || p === null) return null
    const pv = p as Record<string, unknown>
    if (typeof pv.pid !== 'number' || !Number.isInteger(pv.pid)) return null
    if (typeof pv.name !== 'string' || pv.name.length > 260) return null
  }

  // Validate power plan GUID format (or null)
  if (s.originalPowerPlanGuid !== null) {
    if (typeof s.originalPowerPlanGuid !== 'string') return null
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.originalPowerPlanGuid)) return null
  }

  // Validate Focus Assist state — must be a safe integer (0 or 1)
  if (s.originalFocusAssistState !== null) {
    if (typeof s.originalFocusAssistState !== 'number') return null
    if (!Number.isInteger(s.originalFocusAssistState) || s.originalFocusAssistState < 0 || s.originalFocusAssistState > 1) return null
  }

  // Validate powerSaveBlocker ID — integer or null
  if (s.powerSaveBlockerId !== null) {
    if (typeof s.powerSaveBlockerId !== 'number' || !Number.isInteger(s.powerSaveBlockerId)) return null
  }

  // Validate nagle interfaces — registry paths must be safe
  if (!Array.isArray(s.nagleInterfaces)) return null
  const REGISTRY_PATH_RE = /^Microsoft\.PowerShell\.Core\\Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{[0-9A-Fa-f\-]+}$/
  for (const iface of s.nagleInterfaces) {
    if (typeof iface !== 'object' || iface === null) return null
    const iv = iface as Record<string, unknown>
    if (typeof iv.path !== 'string' || !REGISTRY_PATH_RE.test(iv.path)) return null
    if (iv.originalTcpNoDelay !== null && (typeof iv.originalTcpNoDelay !== 'number' || !Number.isInteger(iv.originalTcpNoDelay) || iv.originalTcpNoDelay < 0 || iv.originalTcpNoDelay > 1)) return null
    // TcpAckFrequency is a DWORD with valid range 0-255 (default 2 per Microsoft docs)
    if (iv.originalTcpAckFrequency !== null && (typeof iv.originalTcpAckFrequency !== 'number' || !Number.isInteger(iv.originalTcpAckFrequency) || iv.originalTcpAckFrequency < 0 || iv.originalTcpAckFrequency > 255)) return null
  }

  // Validate registryTweaks — only paths from our known allowlist
  if (!Array.isArray(s.registryTweaks)) return null
  for (const tweak of s.registryTweaks) {
    if (typeof tweak !== 'object' || tweak === null) return null
    const tv = tweak as Record<string, unknown>
    if (typeof tv.path !== 'string' || !ALLOWED_REGISTRY_TWEAK_PATHS.has(tv.path)) return null
    if (typeof tv.name !== 'string' || !ALLOWED_REGISTRY_TWEAK_NAMES.has(tv.name)) return null
    if (tv.originalValue !== null && (typeof tv.originalValue !== 'number' || !Number.isInteger(tv.originalValue))) return null
  }

  // Validate restoreErrors — display-only diagnostics, never fed back into a
  // shell command, but still bounded so a tampered file can't bloat the UI.
  if ('restoreErrors' in s) {
    if (!Array.isArray(s.restoreErrors)) return null
    if (s.restoreErrors.length > 20) return null
    for (const e of s.restoreErrors) {
      if (typeof e !== 'object' || e === null) return null
      const ev = e as Record<string, unknown>
      if (typeof ev.optimizationId !== 'string' || ev.optimizationId.length > 100) return null
      if (typeof ev.reason !== 'string' || ev.reason.length > 500) return null
    }
  }

  return s as unknown as GameModeSnapshot
}

// In-memory reference to the powerSaveBlocker ID (also stored in snapshot for restart recovery)
let activePowerBlockerId: number | null = null

function readSnapshot(): GameModeSnapshot | null {
  try {
    const path = getSnapshotPath()
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    const snapshot = validateSnapshot(raw)
    if (!snapshot) return null

    // A powerSaveBlocker ID only means anything inside the process that created
    // it. If this process didn't, the blocker died with the old process and the
    // ID is dead weight — carrying it would queue a restore step that can never
    // do anything. Drop it so it can't keep a residual snapshot alive.
    if (activePowerBlockerId === null) snapshot.powerSaveBlockerId = null

    return snapshot
  } catch {
    return null
  }
}

function writeSnapshot(snapshot: GameModeSnapshot): void {
  writeFileSync(getSnapshotPath(), JSON.stringify(snapshot, null, 2), 'utf-8')
}

function deleteSnapshot(): void {
  try {
    unlinkSync(getSnapshotPath())
  } catch { /* already gone */ }
}

// ── Process name lists ───────────────────────────────────────

const BROWSER_PROCESSES = ['chrome.exe', 'firefox.exe', 'msedge.exe', 'opera.exe', 'brave.exe', 'vivaldi.exe']
const CHAT_PROCESSES = [
  'Discord.exe',
  'Slack.exe',
  'Teams.exe',
  'ms-teams.exe',
  'Telegram.exe',
  'WhatsApp.exe',
  'Signal.exe',
  'Element.exe',
  'Messenger.exe',
  'Skype.exe',
]
const UPDATER_PROCESSES = [
  'GoogleUpdate.exe',
  'MicrosoftEdgeUpdate.exe',
  'AdobeARM.exe',
  'jusched.exe',
  'BraveUpdate.exe',
  'OperaUpdate.exe',
  'CCleaner.exe',
  'CCUpdate.exe',
  'Dropbox.Update.exe',
  'ZoomUpdateAgent.exe',
]

const PROTECTED_PROCESSES = new Set([
  'csrss.exe', 'smss.exe', 'wininit.exe', 'services.exe',
  'lsass.exe', 'lsaiso.exe', 'svchost.exe', 'winlogon.exe',
  'dwm.exe', 'explorer.exe', 'ntoskrnl.exe', 'system',
  'registry', 'memory compression',
  'launchd', 'kernel_task', 'windowserver',
  'systemd', 'init', 'kthreadd',
])

// ── Helper: run PowerShell ───────────────────────────────────

async function ps(script: string, timeout = 15000): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', psUtf8(script),
  ], { timeout, windowsHide: true })
  return stdout.trim()
}

// ── Individual optimizations ─────────────────────────────────

async function captureAndDisableService(
  serviceName: string,
  snapshot: GameModeSnapshot,
): Promise<void> {
  const info = await ps(
    `Get-Service -Name '${serviceName}' -ErrorAction Stop | ` +
    `Select-Object -Property StartType,Status | ConvertTo-Json -Compress`
  )
  const parsed = JSON.parse(info)
  const originalStartType = String(parsed.StartType ?? parsed.startType ?? 'Manual')
  const wasRunning = String(parsed.Status ?? parsed.status ?? '').toLowerCase().includes('running')

  snapshot.services.push({ name: serviceName, originalStartType, wasRunning })

  if (wasRunning) {
    await ps(`Stop-Service -Name '${serviceName}' -Force -ErrorAction SilentlyContinue`)
  }
  await ps(`Set-Service -Name '${serviceName}' -StartupType Disabled -ErrorAction Stop`)
}

async function restoreService(
  entry: { name: string; originalStartType: string; wasRunning: boolean },
): Promise<void> {
  // Map .NET StartType enum values to Set-Service accepted strings
  const typeMap: Record<string, string> = {
    'Automatic': 'Automatic',
    'Manual': 'Manual',
    'Disabled': 'Disabled',
    'Boot': 'Automatic',
    'System': 'Automatic',
    // Numeric values from some PowerShell versions
    '2': 'Automatic',
    '3': 'Manual',
    '4': 'Disabled',
  }
  const targetType = typeMap[entry.originalStartType] ?? 'Manual'
  // A service that no longer exists has nothing left to restore. Without this
  // guard `Set-Service -ErrorAction Stop` would throw on every retry forever.
  await ps(
    `if (Get-Service -Name '${entry.name}' -ErrorAction SilentlyContinue) { ` +
    `Set-Service -Name '${entry.name}' -StartupType ${targetType} -ErrorAction Stop }`
  )
  if (entry.wasRunning && targetType !== 'Disabled') {
    await ps(`Start-Service -Name '${entry.name}' -ErrorAction SilentlyContinue`)
  }
}

async function killProcessesByName(
  names: string[],
  snapshot: GameModeSnapshot,
): Promise<{ killed: number; errors: string[] }> {
  let killed = 0
  const errors: string[] = []

  try {
    const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], {
      timeout: 10000,
      windowsHide: true,
    })
    const lowerNames = new Set(names.map((n) => n.toLowerCase()))
    const lines = stdout.split('\n').filter(Boolean)

    for (const line of lines) {
      const match = line.match(/^"([^"]+)","(\d+)"/)
      if (!match) continue
      const [, procName, pidStr] = match
      const pid = parseInt(pidStr, 10)
      if (isNaN(pid) || pid <= 4) continue
      if (PROTECTED_PROCESSES.has(procName.toLowerCase())) continue
      if (!lowerNames.has(procName.toLowerCase())) continue

      try {
        process.kill(pid)
        snapshot.killedProcesses.push({ pid, name: procName })
        killed++
      } catch {
        try {
          await execFileAsync('taskkill', ['/PID', String(pid), '/F'], {
            timeout: 5000,
            windowsHide: true,
          })
          snapshot.killedProcesses.push({ pid, name: procName })
          killed++
        } catch (err: any) {
          errors.push(`Failed to kill ${procName} (${pid}): ${err?.message ?? 'unknown'}`)
        }
      }
    }
  } catch (err: any) {
    errors.push(`Process enumeration failed: ${err?.message ?? 'unknown'}`)
  }

  return { killed, errors }
}

async function clearStandbyMemory(): Promise<void> {
  // Trigger .NET garbage collection and trim working sets
  await ps(
    `[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers(); [System.GC]::Collect()`,
    10000,
  )
}

async function capturePowerPlan(snapshot: GameModeSnapshot): Promise<void> {
  try {
    const out = await ps(`powercfg /GETACTIVESCHEME`)
    const match = out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
    snapshot.originalPowerPlanGuid = match?.[1] ?? null
  } catch {
    snapshot.originalPowerPlanGuid = null
  }
}

async function setHighPerformancePlan(): Promise<void> {
  // 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c = High Performance
  await execFileAsync('powercfg', ['/SETACTIVE', '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'], {
    timeout: 5000,
    windowsHide: true,
  })
}

async function restorePowerPlan(guid: string): Promise<void> {
  if (!guid) return
  await execFileAsync('powercfg', ['/SETACTIVE', guid], {
    timeout: 5000,
    windowsHide: true,
  })
}

async function enableFocusAssist(snapshot: GameModeSnapshot): Promise<void> {
  try {
    const out = await ps(
      `$p = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings'; ` +
      `if (Test-Path $p) { (Get-ItemProperty -Path $p -Name NOC_GLOBAL_SETTING_TOASTS_ENABLED -ErrorAction SilentlyContinue).NOC_GLOBAL_SETTING_TOASTS_ENABLED } else { 1 }`
    )
    const parsed = parseInt(out, 10)
    // Clamp to 0 or 1 — the only safe restore values for this DWORD
    snapshot.originalFocusAssistState = (isNaN(parsed) || parsed !== 0) ? 1 : 0
  } catch {
    snapshot.originalFocusAssistState = 1
  }

  await ps(
    `$p = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings'; ` +
    `if (!(Test-Path $p)) { New-Item -Path $p -Force | Out-Null }; ` +
    `Set-ItemProperty -Path $p -Name NOC_GLOBAL_SETTING_TOASTS_ENABLED -Value 0 -Type DWord -Force`
  )
}

async function restoreFocusAssist(originalState: number | null): Promise<void> {
  if (originalState === null) return
  await ps(
    `$p = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings'; ` +
    `if (!(Test-Path $p)) { New-Item -Path $p -Force | Out-Null }; ` +
    `Set-ItemProperty -Path $p -Name NOC_GLOBAL_SETTING_TOASTS_ENABLED -Value ${originalState} -Type DWord -Force`
  )
}

// ── Generic registry tweak helpers ───────────────────────────

/** Capture a DWORD registry value, set a new value, and record the original in the snapshot */
async function applyRegistryTweak(
  snapshot: GameModeSnapshot,
  regPath: string,
  name: string,
  newValue: number,
): Promise<void> {
  // Capture original value
  let originalValue: number | null = null
  try {
    const out = await ps(
      `$v = (Get-ItemProperty -Path '${regPath}' -Name '${name}' -ErrorAction SilentlyContinue).'${name}'; if ($v -ne $null) { $v } else { 'NULL' }`
    )
    if (out !== 'NULL' && out !== '') {
      const parsed = parseInt(out, 10)
      if (!isNaN(parsed)) originalValue = parsed
    }
  } catch { /* key doesn't exist yet — original is null */ }

  snapshot.registryTweaks.push({ path: regPath, name, originalValue })

  // Set new value
  await ps(
    `$p = '${regPath}'; ` +
    `if (!(Test-Path $p)) { New-Item -Path $p -Force | Out-Null }; ` +
    `Set-ItemProperty -Path $p -Name '${name}' -Value ${newValue} -Type DWord -Force`
  )
}

/**
 * Restore all registry tweaks from snapshot.
 * Reports the tweaks that failed so the caller can keep only those pending —
 * re-running the ones that already succeeded on every retry is pointless.
 */
async function restoreRegistryTweaks(
  tweaks: GameModeSnapshot['registryTweaks'],
): Promise<{
  restored: number
  failed: GameModeSnapshot['registryTweaks']
  errors: Array<{ path: string; name: string; reason: string }>
}> {
  let restored = 0
  const failed: GameModeSnapshot['registryTweaks'] = []
  const errors: Array<{ path: string; name: string; reason: string }> = []
  for (const tweak of tweaks) {
    try {
      if (tweak.originalValue !== null) {
        // Recreate the key if it vanished — otherwise Set-ItemProperty throws
        // and this tweak stays pending forever.
        await ps(
          `$p = '${tweak.path}'; ` +
          `if (!(Test-Path $p)) { New-Item -Path $p -Force | Out-Null }; ` +
          `Set-ItemProperty -Path $p -Name '${tweak.name}' -Value ${tweak.originalValue} -Type DWord -Force`
        )
      } else {
        await ps(`Remove-ItemProperty -Path '${tweak.path}' -Name '${tweak.name}' -ErrorAction SilentlyContinue`)
      }
      restored++
    } catch (err: any) {
      failed.push(tweak)
      errors.push({ path: tweak.path, name: tweak.name, reason: err?.message ?? 'unknown' })
    }
  }
  return { restored, failed, errors }
}

// ── Game Bar / DVR ──────────────────────────────────────────

async function disableGameBar(snapshot: GameModeSnapshot): Promise<void> {
  await applyRegistryTweak(snapshot, 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR', 'AppCaptureEnabled', 0)
  await applyRegistryTweak(snapshot, 'HKCU:\\System\\GameConfigStore', 'GameDVR_Enabled', 0)
}

// ── Fullscreen optimizations ────────────────────────────────

async function disableFullscreenOptimizations(snapshot: GameModeSnapshot): Promise<void> {
  await applyRegistryTweak(snapshot, 'HKCU:\\System\\GameConfigStore', 'GameDVR_FSEBehaviorMode', 2)
  await applyRegistryTweak(snapshot, 'HKCU:\\System\\GameConfigStore', 'GameDVR_HonorUserFSEBehaviorMode', 1)
  await applyRegistryTweak(snapshot, 'HKCU:\\System\\GameConfigStore', 'GameDVR_DXGIHonorFSEWindowsCompatible', 1)
  await applyRegistryTweak(snapshot, 'HKCU:\\System\\GameConfigStore', 'GameDVR_EFSEFeatureFlags', 0)
}

// ── Transparency ────────────────────────────────────────────

async function disableTransparency(snapshot: GameModeSnapshot): Promise<void> {
  await applyRegistryTweak(snapshot, 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', 'EnableTransparency', 0)
}

async function disableNagle(snapshot: GameModeSnapshot): Promise<void> {
  const out = await ps(
    `Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces' | ForEach-Object { ` +
    `  $path = $_.PSPath; ` +
    `  $noDelay = (Get-ItemProperty -Path $path -Name TcpNoDelay -ErrorAction SilentlyContinue).TcpNoDelay; ` +
    `  $ackFreq = (Get-ItemProperty -Path $path -Name TcpAckFrequency -ErrorAction SilentlyContinue).TcpAckFrequency; ` +
    `  [PSCustomObject]@{ Path=$path; TcpNoDelay=$noDelay; TcpAckFrequency=$ackFreq } ` +
    `} | ConvertTo-Json -Compress`
  )

  let interfaces: any[] = []
  try {
    const parsed = JSON.parse(out)
    interfaces = Array.isArray(parsed) ? parsed : [parsed]
  } catch { return }

  for (const iface of interfaces) {
    if (!iface?.Path) continue
    snapshot.nagleInterfaces.push({
      path: iface.Path,
      originalTcpNoDelay: iface.TcpNoDelay ?? null,
      originalTcpAckFrequency: iface.TcpAckFrequency ?? null,
    })
  }

  await ps(
    `Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces' | ForEach-Object { ` +
    `  Set-ItemProperty -Path $_.PSPath -Name TcpNoDelay -Value 1 -Type DWord -Force; ` +
    `  Set-ItemProperty -Path $_.PSPath -Name TcpAckFrequency -Value 1 -Type DWord -Force ` +
    `}`
  )
}

/**
 * Restore per-interface Nagle settings.
 * Interfaces that no longer exist (VPN / virtual adapters routinely disappear
 * across a reboot) count as restored — there is nothing left to write to.
 * Returns the interfaces still pending so the caller can scrub the rest.
 */
async function restoreNagle(
  interfaces: GameModeSnapshot['nagleInterfaces'],
): Promise<{
  restored: number
  failed: GameModeSnapshot['nagleInterfaces']
  errors: string[]
}> {
  let restored = 0
  const failed: GameModeSnapshot['nagleInterfaces'] = []
  const errors: string[] = []
  for (const iface of interfaces) {
    const noDelay = iface.originalTcpNoDelay !== null
      ? `Set-ItemProperty -Path $p -Name TcpNoDelay -Value ${iface.originalTcpNoDelay} -Type DWord -Force`
      : `Remove-ItemProperty -Path $p -Name TcpNoDelay -ErrorAction SilentlyContinue`
    const ackFreq = iface.originalTcpAckFrequency !== null
      ? `Set-ItemProperty -Path $p -Name TcpAckFrequency -Value ${iface.originalTcpAckFrequency} -Type DWord -Force`
      : `Remove-ItemProperty -Path $p -Name TcpAckFrequency -ErrorAction SilentlyContinue`
    try {
      await ps(`$p = '${iface.path}'; if (Test-Path $p) { ${noDelay}; ${ackFreq} }`)
      restored++
    } catch (err: any) {
      failed.push(iface)
      errors.push(err?.message ?? 'unknown')
    }
  }
  return { restored, failed, errors }
}

// ── Activate / Deactivate ────────────────────────────────────

export async function activateGameMode(
  config: GameModeConfig,
  onProgress: (p: GameModeProgress) => void,
): Promise<GameModeActivateResult> {
  const enabled = config.enabledOptimizations
  const total = enabled.length
  let succeeded = 0
  const errors: GameModeActivateResult['errors'] = []

  const snapshot: GameModeSnapshot = {
    activatedAt: new Date().toISOString(),
    active: true,
    services: [],
    killedProcesses: [],
    originalPowerPlanGuid: null,
    originalFocusAssistState: null,
    powerSaveBlockerId: null,
    nagleInterfaces: [],
    registryTweaks: [],
  }

  const admin = isAdmin()

  for (let i = 0; i < enabled.length; i++) {
    const id = enabled[i]
    onProgress({ phase: 'activating', current: i + 1, total, currentLabel: id })

    try {
      // Services
      if (id in SERVICE_MAP) {
        if (!admin) throw new Error('Administrator privileges required')
        await captureAndDisableService(SERVICE_MAP[id], snapshot)
        succeeded++
        writeSnapshot(snapshot) // persist after each change so crashes don't orphan it
        continue
      }

      // Processes
      if (id === 'proc-kill-browsers') {
        const r = await killProcessesByName(BROWSER_PROCESSES, snapshot)
        if (r.errors.length) throw new Error(r.errors[0])
        succeeded++
        continue
      }
      if (id === 'proc-kill-chat') {
        const r = await killProcessesByName(CHAT_PROCESSES, snapshot)
        if (r.errors.length) throw new Error(r.errors[0])
        succeeded++
        continue
      }
      if (id === 'proc-kill-updaters') {
        const r = await killProcessesByName(UPDATER_PROCESSES, snapshot)
        if (r.errors.length) throw new Error(r.errors[0])
        succeeded++
        continue
      }
      if (id === 'proc-kill-custom') {
        if (config.customProcessKillList.length > 0) {
          const r = await killProcessesByName(config.customProcessKillList, snapshot)
          if (r.errors.length) throw new Error(r.errors[0])
        }
        succeeded++
        continue
      }

      // Memory
      if (id === 'mem-clear-standby') {
        await clearStandbyMemory()
        succeeded++
        continue
      }

      // System
      if (id === 'sys-focus-assist') {
        await enableFocusAssist(snapshot)
        succeeded++
        writeSnapshot(snapshot)
        continue
      }
      if (id === 'sys-power-plan') {
        await capturePowerPlan(snapshot)
        await setHighPerformancePlan()
        succeeded++
        writeSnapshot(snapshot)
        continue
      }
      if (id === 'sys-prevent-sleep') {
        activePowerBlockerId = powerSaveBlocker.start('prevent-display-sleep')
        snapshot.powerSaveBlockerId = activePowerBlockerId
        succeeded++
        writeSnapshot(snapshot)
        continue
      }
      if (id === 'sys-disable-game-bar') {
        await disableGameBar(snapshot)
        succeeded++
        writeSnapshot(snapshot)
        continue
      }
      if (id === 'sys-disable-fse-opt') {
        await disableFullscreenOptimizations(snapshot)
        succeeded++
        writeSnapshot(snapshot)
        continue
      }
      if (id === 'sys-disable-transparency') {
        await disableTransparency(snapshot)
        succeeded++
        writeSnapshot(snapshot)
        continue
      }

      // Network
      if (id === 'net-flush-dns') {
        const platform = getPlatform()
        const ok = await (platform.network.flushDnsCache?.() ?? Promise.resolve(false))
        if (!ok) throw new Error('DNS flush failed')
        succeeded++
        continue
      }
      if (id === 'net-disable-nagle') {
        if (!admin) throw new Error('Administrator privileges required')
        await disableNagle(snapshot)
        succeeded++
        writeSnapshot(snapshot)
        continue
      }
    } catch (err: any) {
      errors.push({ optimizationId: id, reason: err?.message ?? 'Unknown error' })
    }
  }

  // Only persist the snapshot if at least one optimization changed system state.
  // If everything failed, don't leave an empty snapshot that blocks future activations.
  if (succeeded > 0) {
    writeSnapshot(snapshot)
  }

  return { succeeded, failed: errors.length, errors, snapshot }
}

export async function deactivateGameMode(
  onProgress: (p: GameModeProgress) => void,
): Promise<GameModeDeactivateResult> {
  const snapshot = readSnapshot()
  if (!snapshot) {
    return { restored: 0, failed: 0, errors: [] }
  }

  let restored = 0
  const errors: GameModeDeactivateResult['errors'] = []

  // `residual` holds everything that still needs restoring. Each step that
  // succeeds scrubs its own entries from it. If anything remains after all
  // steps run, we persist it so the user can retry restoration without losing
  // the captured pre-Game-Mode state.
  const residual: GameModeSnapshot = {
    ...snapshot,
    services: [...snapshot.services],
    killedProcesses: [...snapshot.killedProcesses],
    nagleInterfaces: [...snapshot.nagleInterfaces],
    registryTweaks: [...snapshot.registryTweaks],
  }

  const steps: Array<{ id: string; fn: () => Promise<void>; clear: () => void }> = []

  // Restore services
  for (const svc of snapshot.services) {
    steps.push({
      id: `svc-restore-${svc.name}`,
      fn: () => restoreService(svc),
      clear: () => { residual.services = residual.services.filter((s) => s.name !== svc.name) },
    })
  }

  // Restore power plan
  if (snapshot.originalPowerPlanGuid) {
    steps.push({
      id: 'sys-power-plan',
      fn: () => restorePowerPlan(snapshot.originalPowerPlanGuid!),
      clear: () => { residual.originalPowerPlanGuid = null },
    })
  }

  // Restore Focus Assist
  if (snapshot.originalFocusAssistState !== null) {
    steps.push({
      id: 'sys-focus-assist',
      fn: () => restoreFocusAssist(snapshot.originalFocusAssistState),
      clear: () => { residual.originalFocusAssistState = null },
    })
  }

  // Stop power save blocker
  if (snapshot.powerSaveBlockerId !== null || activePowerBlockerId !== null) {
    steps.push({
      id: 'sys-prevent-sleep',
      fn: async () => {
        const id = activePowerBlockerId ?? snapshot.powerSaveBlockerId
        if (id !== null && powerSaveBlocker.isStarted(id)) {
          powerSaveBlocker.stop(id)
        }
        activePowerBlockerId = null
      },
      clear: () => { residual.powerSaveBlockerId = null },
    })
  }

  // Restore Nagle. Grouped steps narrow the residual to the entries that
  // actually failed before throwing, so a single stuck interface doesn't drag
  // the healthy ones into every future retry.
  if (snapshot.nagleInterfaces.length > 0) {
    steps.push({
      id: 'net-disable-nagle',
      fn: async () => {
        const r = await restoreNagle(snapshot.nagleInterfaces)
        residual.nagleInterfaces = r.failed
        if (r.failed.length > 0) {
          throw new Error(`${r.failed.length} network interface(s) failed to restore: ${r.errors[0]}`)
        }
      },
      clear: () => { residual.nagleInterfaces = [] },
    })
  }

  // Restore registry tweaks (Game Bar, FSE, transparency)
  if (snapshot.registryTweaks.length > 0) {
    steps.push({
      id: 'sys-registry-tweaks',
      fn: async () => {
        const r = await restoreRegistryTweaks(snapshot.registryTweaks)
        residual.registryTweaks = r.failed
        if (r.failed.length > 0) {
          throw new Error(`${r.failed.length} registry value(s) failed to restore: ${r.errors[0].reason}`)
        }
      },
      clear: () => { residual.registryTweaks = [] },
    })
  }

  const total = steps.length
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    onProgress({ phase: 'deactivating', current: i + 1, total, currentLabel: step.id })
    try {
      await step.fn()
      step.clear()
      restored++
    } catch (err: any) {
      errors.push({ optimizationId: step.id, reason: err?.message ?? 'Unknown error' })
    }
  }

  // Mark inactive unconditionally so the UI toggle always releases. If every
  // step succeeded, drop the snapshot entirely. Otherwise persist the residual
  // (active: false) so a later retry can still access the original values.
  if (errors.length === 0) {
    deleteSnapshot()
  } else {
    residual.active = false
    // Persist why, so the cleanup banner can name the stuck step even after
    // the app restarts.
    residual.restoreErrors = errors.map((e) => ({
      optimizationId: e.optimizationId,
      reason: (e.reason ?? 'Unknown error').slice(0, 500),
    }))
    writeSnapshot(residual)
  }
  return { restored, failed: errors.length, errors }
}

/**
 * Drop a residual snapshot without restoring it. The escape hatch for a
 * restore step that can never succeed on this machine — without it, activation
 * stays blocked forever and the only fix is deleting the file by hand.
 * Refuses while Game Mode is live: discarding then would strand real changes.
 */
export function discardPendingRestore(): { discarded: boolean; reason?: string } {
  const snapshot = readSnapshot()
  if (snapshot?.active === true) {
    return { discarded: false, reason: 'Game Mode is still active — deactivate it first' }
  }
  // A snapshot that fails validation reads back as null but the file is still
  // on disk blocking nothing; deleting it here also clears that case.
  deleteSnapshot()
  return { discarded: true }
}

export function getGameModeStatus(): GameModeStatus {
  const snapshot = readSnapshot()
  return {
    active: snapshot?.active === true,
    activatedAt: snapshot?.activatedAt ?? null,
    pendingRestore: snapshot !== null && snapshot.active === false,
    pendingReason: snapshot?.restoreErrors?.[0]?.reason ?? null,
  }
}

// ── IPC Registration ─────────────────────────────────────────

const VALID_OPTIMIZATION_IDS = new Set<string>([
  'svc-wsearch', 'svc-sysmain', 'svc-wuauserv', 'svc-spooler', 'svc-diagtrack',
  'proc-kill-browsers', 'proc-kill-chat', 'proc-kill-updaters', 'proc-kill-custom',
  'mem-clear-standby',
  'sys-focus-assist', 'sys-power-plan', 'sys-prevent-sleep',
  'sys-disable-game-bar', 'sys-disable-fse-opt', 'sys-disable-transparency',
  'net-flush-dns', 'net-disable-nagle',
])

const PROCESS_NAME_RE = /^[A-Za-z0-9._\- ]+$/

function validateGameModeConfig(input: unknown): GameModeConfig | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const obj = input as Record<string, unknown>

  if (!Array.isArray(obj.enabledOptimizations)) return null
  if (obj.enabledOptimizations.length > 30) return null
  if (!obj.enabledOptimizations.every((v: unknown) => typeof v === 'string' && VALID_OPTIMIZATION_IDS.has(v as string))) return null

  if (!Array.isArray(obj.customProcessKillList)) return null
  if (obj.customProcessKillList.length > 50) return null
  if (!obj.customProcessKillList.every((v: unknown) =>
    typeof v === 'string' && v.length > 0 && v.length <= 100 && PROCESS_NAME_RE.test(v as string)
  )) return null

  // Auto-detect fields are optional in the activate payload (not used by activate itself)
  if ('autoDetect' in obj && typeof obj.autoDetect !== 'boolean') return null
  if ('autoDeactivate' in obj && typeof obj.autoDeactivate !== 'boolean') return null
  if ('customGameProcesses' in obj) {
    if (!Array.isArray(obj.customGameProcesses)) return null
    if (obj.customGameProcesses.length > 50) return null
    if (!obj.customGameProcesses.every((v: unknown) =>
      typeof v === 'string' && v.length > 0 && v.length <= 100 && PROCESS_NAME_RE.test(v as string)
    )) return null
  }

  return obj as unknown as GameModeConfig
}

// ── Auto-activation tracking ────────────────────────────────────

/** true when Game Mode was activated automatically by the game detector */
let autoActivated = false

export function registerGameModeIpc(getWindow: WindowGetter): void {
  const sendProgress = (data: GameModeProgress): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.GAME_MODE_PROGRESS, data)
  }

  const sendAutoEvent = (event: GameAutoEvent): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.GAME_MODE_AUTO_EVENT, event)
  }

  ipcMain.handle(IPC.GAME_MODE_ACTIVATE, async (_event, rawConfig: unknown) => {
    const config = validateGameModeConfig(rawConfig)
    if (!config) {
      return { succeeded: 0, failed: 1, errors: [{ optimizationId: 'config', reason: 'Invalid config' }], snapshot: null }
    }
    // Prevent double-activation. A snapshot with active:false means a previous
    // deactivation left unrestored items — re-activating now would capture the
    // already-mutated state as the new baseline and lose the original values.
    const existing = readSnapshot()
    if (existing?.active) {
      return { succeeded: 0, failed: 1, errors: [{ optimizationId: 'config', reason: 'Game Mode is already active' }], snapshot: null }
    }
    if (existing) {
      const detail = existing.restoreErrors?.[0]?.reason
      return {
        succeeded: 0,
        failed: 1,
        errors: [{
          optimizationId: 'config',
          reason: detail
            ? `Previous deactivation left unrestored items (${detail}) — retry the cleanup, or discard it to unblock Game Mode`
            : 'Previous deactivation left unrestored items — retry the cleanup, or discard it to unblock Game Mode',
        }],
        snapshot: null,
      }
    }
    autoActivated = false // manual activation
    return activateGameMode(config, sendProgress)
  })

  ipcMain.handle(IPC.GAME_MODE_DEACTIVATE, async () => {
    // If auto-detect is on and a game is still running, suppress re-activation
    if (autoActivated || isDetectorRunning()) {
      suppressCurrentGame()
    }
    autoActivated = false
    return deactivateGameMode(sendProgress)
  })

  ipcMain.handle(IPC.GAME_MODE_STATUS, () => {
    return getGameModeStatus()
  })

  ipcMain.handle(IPC.GAME_MODE_DISCARD_PENDING, () => {
    return discardPendingRestore()
  })

  // ── Auto-detect lifecycle ────────────────────────────────────
  initGameDetector(getWindow, sendProgress, sendAutoEvent)
}

/** Start or restart the game detector based on current settings */
export function initGameDetector(
  getWindow: WindowGetter,
  sendProgress: (data: GameModeProgress) => void,
  sendAutoEvent: (event: GameAutoEvent) => void,
): void {
  // Only supported on Windows
  if (process.platform !== 'win32') return

  const settings = getSettings()
  if (!settings.gameMode.autoDetect) {
    stopGameDetector()
    return
  }

  startGameDetector(
    {
      onGameDetected: async (processName) => {
        // Don't activate if already active
        if (readSnapshot() !== null) return

        const cfg = getSettings().gameMode
        if (cfg.enabledOptimizations.length === 0) return

        autoActivated = true
        await activateGameMode(cfg, sendProgress)
        sendAutoEvent({ type: 'game-detected', processName })
      },
      onGameExited: async () => {
        // Only relevant if we auto-activated
        if (!autoActivated) return

        const wasAutoActivated = autoActivated
        autoActivated = false

        const cfg = getSettings().gameMode
        if (cfg.autoDeactivate !== false && wasAutoActivated) {
          await deactivateGameMode(sendProgress)
        }

        // Always notify renderer so detectedGame clears and status refreshes
        sendAutoEvent({ type: 'game-exited', processName: null })
      },
    },
    settings.gameMode.customGameProcesses ?? [],
  )
}

/** Called when gameMode settings change — restarts the detector if needed. */
export function refreshGameDetector(getWindow: WindowGetter): void {
  const sendProgress = (data: GameModeProgress): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.GAME_MODE_PROGRESS, data)
  }
  const sendAutoEvent = (event: GameAutoEvent): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.GAME_MODE_AUTO_EVENT, event)
  }
  initGameDetector(getWindow, sendProgress, sendAutoEvent)
}
