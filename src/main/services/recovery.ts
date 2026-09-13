import { execNativeUtf8, psUtf8 } from './exec-utf8'
import { getRecoveryEntry, updateRecoveryEntry } from './recovery-store'
import {
  recoveryDecision,
  type RecoveryEntry,
  type RecoveryTarget,
  type RecoveryValue
} from '../../shared/recovery'

export async function readRecoveryTarget(target: RecoveryTarget): Promise<RecoveryValue> {
  if (process.platform !== 'win32')
    throw new Error('This recovery adapter is only available on Windows')
  if (target.kind === 'service-start') {
    if (!/^[A-Za-z0-9_.-]{1,256}$/.test(target.name)) throw new Error('Invalid service name')
    const key = ['HKLM:', 'SYSTEM', 'CurrentControlSet', 'Services', target.name].join(
      String.fromCharCode(92)
    )
    const script =
      "$ErrorActionPreference='Stop'; $v=Get-ItemProperty -LiteralPath '" +
      key +
      "' -ErrorAction Stop; $s=Get-Service -Name '" +
      target.name +
      "' -ErrorAction Stop; @{start=[int]$v.Start;delayed=$v.DelayedAutoStart;running=($s.Status -eq 'Running')} | ConvertTo-Json -Compress"
    const { stdout } = await execNativeUtf8(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)],
      { timeout: 8000, windowsHide: true }
    )
    const value = JSON.parse(stdout)
    if (
      ![0, 1, 2, 3, 4].includes(value.start) ||
      ![null, 0, 1].includes(value.delayed) ||
      typeof value.running !== 'boolean'
    )
      throw new Error('Service state is unavailable')
    return { start: value.start, delayed: value.delayed, running: value.running }
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
    const { stdout } = await execNativeUtf8(
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
    await execNativeUtf8('sc.exe', ['config', target.name, 'start=', modes[value.start]], {
      timeout: 8000,
      windowsHide: true
    })
    const key = ['HKLM', 'SYSTEM', 'CurrentControlSet', 'Services', target.name].join(
      String.fromCharCode(92)
    )
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
    await execNativeUtf8(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)],
      { timeout: 15000, windowsHide: true }
    )
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
