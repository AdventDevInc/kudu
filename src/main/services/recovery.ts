import { execNativeUtf8, execTracked, psUtf8 } from './exec-utf8'
import { getRecoveryEntry, updateRecoveryEntry } from './recovery-store'
import {
  recoveryDecision,
  type RecoveryEntry,
  type RecoveryTarget,
  type RecoveryValue
} from '../../shared/recovery'

export type ServiceState = { start: number; delayed: number | null; running: boolean }
const SERVICE_NAME = /^[A-Za-z0-9_.-]{1,256}$/
function isServiceState(value: unknown): value is ServiceState {
  const v = value as ServiceState
  return (
    !!v &&
    typeof v === 'object' &&
    [0, 1, 2, 3, 4].includes(v.start) &&
    [null, 0, 1].includes(v.delayed) &&
    typeof v.running === 'boolean'
  )
}
/**
 * Read the start type, delayed-start flag, and running state of several services in a
 * single PowerShell process. Services that do not exist or cannot be read are absent
 * from the result rather than failing the whole batch.
 */
export async function readServiceStates(names: string[]): Promise<Map<string, ServiceState>> {
  if (process.platform !== 'win32')
    throw new Error('This recovery adapter is only available on Windows')
  const unique = [...new Set(names)]
  if (unique.some((name) => !SERVICE_NAME.test(name))) throw new Error('Invalid service name')
  if (!unique.length) return new Map()
  const root = ['HKLM:', 'SYSTEM', 'CurrentControlSet', 'Services', ''].join(
    String.fromCharCode(92)
  )
  const script =
    "$ErrorActionPreference='Stop'; $out=@{}; foreach ($n in @(" +
    unique.map((name) => "'" + name + "'").join(',') +
    ")) { try { $v=Get-ItemProperty -LiteralPath ('" +
    root +
    "' + $n) -ErrorAction Stop; $s=Get-Service -Name $n -ErrorAction Stop; " +
    "$out[$n]=@{start=[int]$v.Start;delayed=$v.DelayedAutoStart;running=($s.Status -eq 'Running')} } catch {} }; " +
    '$out | ConvertTo-Json -Compress'
  const { stdout } = await execTracked(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)],
    { timeout: 8000 + unique.length * 1000, windowsHide: true }
  )
  const parsed: unknown = JSON.parse(stdout)
  if (!parsed || typeof parsed !== 'object') throw new Error('Service state is unavailable')
  const states = new Map<string, ServiceState>()
  for (const name of unique) {
    const value = (parsed as Record<string, unknown>)[name]
    if (value === undefined) continue
    if (!isServiceState(value)) throw new Error('Service state is unavailable')
    states.set(name, { start: value.start, delayed: value.delayed, running: value.running })
  }
  return states
}
export async function readRecoveryTarget(target: RecoveryTarget): Promise<RecoveryValue> {
  if (process.platform !== 'win32')
    throw new Error('This recovery adapter is only available on Windows')
  if (target.kind === 'service-start') {
    const state = (await readServiceStates([target.name])).get(target.name)
    if (!state) throw new Error('Service state is unavailable')
    return state
  }
  if (target.kind === 'task-enabled') {
    const { stdout } = await execNativeUtf8('schtasks', ['/query', '/tn', target.name, '/xml'], {
      timeout: 8000,
      windowsHide: true
    })
    const match = stdout.match(/<Settings>[\s\S]*?<Enabled>(true|false)<\/Enabled>/i)
    if (!match) throw new Error('Task state is unavailable')
    return match[1].toLowerCase() === 'true'
  }
  const key = target.key
  const name = target.name
  if (
    !/^HK(CU|LM)\\[A-Za-z0-9_ .()\\-]{1,512}$/.test(key) ||
    !/^[A-Za-z0-9_ .()-]{1,128}$/.test(name)
  )
    throw new Error('Invalid registry target')
  try {
    const { stdout } = await execNativeUtf8('reg', ['query', key, '/v', name], {
      timeout: 5000,
      windowsHide: true
    })
    const match = stdout.match(/REG_DWORD\s+0x([0-9a-f]+)/i)
    if (!match) throw new Error('The original value is not a DWORD')
    return parseInt(match[1], 16)
  } catch (error: any) {
    // reg.exe uses exit 1 for both missing data and access failures; verify via .NET.
    const script = `$ErrorActionPreference='Stop'; $p='${key.replace(/^HKLM/, 'Registry::HKEY_LOCAL_MACHINE').replace(/^HKCU/, 'Registry::HKEY_CURRENT_USER')}'; if (!(Test-Path -LiteralPath $p)) { 'MISSING' } else { $k=Get-Item -LiteralPath $p -ErrorAction Stop; if ($k.GetValueNames() -contains '${name}') { throw 'Value could not be read' } else { 'MISSING' } }`
    const { stdout } = await execTracked(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)],
      { timeout: 8000, windowsHide: true }
    )
    if (stdout.trim() === 'MISSING' && target.kind === 'registry-dword') return null
    throw error
  }
}
export async function writeRecoveryTarget(
  target: RecoveryTarget,
  value: RecoveryValue
): Promise<void> {
  if (target.kind === 'task-enabled') {
    await execNativeUtf8(
      'schtasks',
      ['/change', '/tn', target.name, value ? '/enable' : '/disable'],
      { timeout: 8000, windowsHide: true }
    )
  } else if (target.kind === 'service-start') {
    if (!value || typeof value !== 'object') throw new Error('Invalid service state')
    const modes: Record<number, string> = {
      0: 'boot',
      1: 'system',
      2: value.delayed === 1 ? 'delayed-auto' : 'auto',
      3: 'demand',
      4: 'disabled'
    }
    // The start type and delayed flag are written by different tools, so each step is
    // attempted even when the other fails. Every step is idempotent, and recoveryDecision
    // recognises a half-applied state, so a later attempt finishes the job.
    const failures: unknown[] = []
    await execTracked('sc.exe', ['config', target.name, 'start=', modes[value.start]], {
      timeout: 8000,
      windowsHide: true
    }).catch((error) => failures.push(error))
    const key = ['HKLM', 'SYSTEM', 'CurrentControlSet', 'Services', target.name].join(
      String.fromCharCode(92)
    )
    try {
      const currentDelayed = await readRecoveryTarget({
        kind: 'registry-dword',
        key,
        name: 'DelayedAutoStart'
      })
      if (currentDelayed !== value.delayed)
        await writeRecoveryTarget(
          { kind: 'registry-dword', key, name: 'DelayedAutoStart' },
          value.delayed
        )
    } catch (error) {
      failures.push(error)
    }
    if (failures.length) throw failures[0]
    const condition = value.running ? "$s.Status -ne 'Running'" : "$s.Status -ne 'Stopped'"
    const command = value.running ? 'Start-Service' : 'Stop-Service'
    const script =
      "$ErrorActionPreference='Stop'; $s=Get-Service -Name '" +
      target.name +
      "'; if (" +
      condition +
      ') { ' +
      command +
      " -Name '" +
      target.name +
      "' -ErrorAction Stop }"
    await execTracked('powershell', ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)], {
      timeout: 15000,
      windowsHide: true
    })
  } else {
    await execNativeUtf8(
      'reg',
      value === null
        ? ['delete', target.key, '/v', target.name, '/f']
        : ['add', target.key, '/v', target.name, '/t', 'REG_DWORD', '/d', String(value), '/f'],
      { timeout: 8000, windowsHide: true }
    )
  }
}
let restoring = false
export async function restoreRecoveryEntry(id: unknown) {
  if (restoring) throw new Error('Recovery is already running')
  if (typeof id !== 'string') throw new Error('Invalid recovery ID')
  restoring = true
  let entry: RecoveryEntry | undefined
  try {
    entry = await getRecoveryEntry(id)
    if (!entry) throw new Error('Recovery entry not found')
    const decision = recoveryDecision(
      await readRecoveryTarget(entry.target),
      entry.before,
      entry.after
    )
    if (decision === 'conflict') {
      entry.status = 'conflict'
      entry.error = 'The value changed after Kudu modified it. The newer value was preserved.'
    } else {
      if (decision === 'restore') await writeRecoveryTarget(entry.target, entry.before)
      if (
        recoveryDecision(await readRecoveryTarget(entry.target), entry.before, entry.after) !==
        'already-restored'
      )
        throw new Error('Restored value could not be verified')
      entry.status = 'restored'
      delete entry.error
    }
    await updateRecoveryEntry(entry)
    return entry
  } catch (error) {
    if (entry) {
      entry.status = 'failed'
      entry.error = error instanceof Error ? error.message.slice(0, 500) : 'Recovery failed'
      await updateRecoveryEntry(entry)
    }
    throw error
  } finally {
    restoring = false
  }
}
