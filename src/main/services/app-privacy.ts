import { execFile } from 'child_process'
import { promisify } from 'util'
import { psUtf8 } from './exec-utf8'
import {
  APP_PRIVACY_CAPABILITIES,
  appPrivacyLastUse,
  type AppPrivacyReport,
  type AppPrivacyCapabilitySummary,
  type AppPrivacyRecord,
  type RecordedConsent
} from '../../shared/app-privacy'

const execFileAsync = promisify(execFile)

// A fixed, read-only script. Registry names never become PowerShell source or paths to open.
// HKCU intentionally means the process account, including when launched as another user.
export const APP_PRIVACY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$base = 'Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore'
$results = @()
$records = [System.Collections.Generic.List[object]]::new()
foreach ($cap in @('webcam','microphone','location')) {
  $summary = @{ capability=$cap; status='available'; userConsent=$null; desktopConsent=$null; deviceConsent=$null; truncated=$false }
  $root = $null
  try {
    $root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($base+'\'+$cap, $false)
    if ($null -eq $root) { $summary.status='missing' }
    else {
      $summary.userConsent = $root.GetValue('Value')
      $count = 0
      foreach ($name in $root.GetSubKeyNames()) {
        $child = $null
        try {
          $child = $root.OpenSubKey($name, $false)
          if ($null -eq $child) { throw 'Entry disappeared' }
          if ($name -eq 'NonPackaged') {
            $summary.desktopConsent = $child.GetValue('Value')
            foreach ($appName in $child.GetSubKeyNames()) {
              if ($count -ge 1000) { $summary.truncated=$true; break }
              $entry = $null
              try {
                $entry = $child.OpenSubKey($appName, $false)
                if ($null -eq $entry) { throw 'Entry disappeared' }
                $records.Add(@{ capability=$cap; kind='desktop'; identity=$appName; consent=$entry.GetValue('Value'); start=[string]$entry.GetValue('LastUsedTimeStart'); end=[string]$entry.GetValue('LastUsedTimeStop') })
                $count++
              } catch { $summary.status='partial' } finally { if ($null -ne $entry) { $entry.Dispose() } }
            }
          } else {
            if ($count -ge 1000) { $summary.truncated=$true; continue }
            $records.Add(@{ capability=$cap; kind='packaged'; identity=$name; consent=$child.GetValue('Value'); start=[string]$child.GetValue('LastUsedTimeStart'); end=[string]$child.GetValue('LastUsedTimeStop') })
            $count++
          }
        } catch { $summary.status='partial' } finally { if ($null -ne $child) { $child.Dispose() } }
      }
    }
  } catch { $summary.status='unavailable' } finally { if ($null -ne $root) { $root.Dispose() } }
  $device = $null
  try {
    $device = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($base+'\'+$cap, $false)
    if ($null -ne $device) { $summary.deviceConsent=$device.GetValue('Value') }
  } catch { $summary.status='partial' } finally { if ($null -ne $device) { $device.Dispose() } }
  $results += $summary
}
@{ account=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; capabilities=$results; records=$records.ToArray() } | ConvertTo-Json -Depth 5 -Compress
`

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function consent(value: unknown): RecordedConsent {
  switch (typeof value === 'string' ? value.toLowerCase() : '') {
    case 'allow':
      return 'allow'
    case 'deny':
      return 'deny'
    case 'prompt':
      return 'prompt'
    default:
      return 'unknown'
  }
}

/** FILETIME must remain a decimal string: a JSON number loses sub-millisecond precision. */
export function parsePrivacyFiletime(value: unknown, now: number): string | null {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return null
  const ticks = BigInt(value)
  const milliseconds = Number(ticks / 10000n - 11644473600000n)
  if (ticks === 0n || milliseconds < 0 || milliseconds > now) return null
  return new Date(milliseconds).toISOString()
}

export function parseAppPrivacyReport(raw: unknown, now = Date.now()): AppPrivacyReport {
  const data = object(raw)
  if (!Array.isArray(data.capabilities) || !Array.isArray(data.records)) {
    throw new Error('Invalid app privacy scan response')
  }
  const capabilities = APP_PRIVACY_CAPABILITIES.map((capability): AppPrivacyCapabilitySummary => {
    const summary = object(
      (data.capabilities as unknown[]).find((x) => object(x).capability === capability)
    )
    const status = summary.status
    return {
      capability,
      status:
        status === 'available' || status === 'missing' || status === 'partial'
          ? status
          : ('unavailable' as const),
      userConsent: consent(summary.userConsent),
      desktopConsent: consent(summary.desktopConsent),
      deviceConsent: consent(summary.deviceConsent),
      truncated: summary.truncated === true
    }
  })
  const records = new Map<string, AppPrivacyRecord>()
  for (const value of data.records) {
    const row = object(value)
    const capability = APP_PRIVACY_CAPABILITIES.find((cap) => cap === row.capability)
    if (
      !capability ||
      (row.kind !== 'desktop' && row.kind !== 'packaged') ||
      typeof row.identity !== 'string' ||
      !row.identity ||
      row.identity.length > 32768
    )
      continue
    const identity = row.kind === 'desktop' ? row.identity.replaceAll('#', '\\') : row.identity
    const id = `${capability}:${row.kind}:${identity.toLowerCase()}`
    const lastAccess = parsePrivacyFiletime(row.start, now)
    const stop = parsePrivacyFiletime(row.end, now)
    const lastEnd = lastAccess && stop && stop >= lastAccess ? stop : null
    const record: AppPrivacyRecord = {
      id,
      capability,
      kind: row.kind,
      identity,
      name:
        row.kind === 'desktop' ? identity.split('\\').at(-1) || identity : identity.split('_')[0],
      consent: consent(row.consent),
      lastAccess,
      lastEnd,
      usage: lastEnd ? 'recorded' : lastAccess && row.end === '0' ? 'unfinished' : 'unknown'
    }
    const existing = records.get(id)
    if (existing) {
      // Case variants of the same Windows identity should not inflate entry counts.
      const newer = (record.lastAccess ?? '') > (existing.lastAccess ?? '') ? record : existing
      records.set(id, {
        ...newer,
        consent: existing.consent === record.consent ? existing.consent : 'unknown'
      })
    } else records.set(id, record)
  }
  return {
    supported: true,
    scannedAt: new Date(now).toISOString(),
    account: typeof data.account === 'string' ? data.account.slice(0, 512) : '',
    capabilities,
    records: [...records.values()].sort(
      (a, b) =>
        (appPrivacyLastUse(b) ?? '').localeCompare(appPrivacyLastUse(a) ?? '') ||
        a.identity.localeCompare(b.identity)
    )
  }
}

export async function scanAppPrivacy(): Promise<AppPrivacyReport> {
  if (process.platform !== 'win32')
    return {
      supported: false,
      account: '',
      scannedAt: new Date().toISOString(),
      capabilities: [],
      records: []
    }
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psUtf8(APP_PRIVACY_SCRIPT)],
    { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }
  )
  return parseAppPrivacyReport(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()))
}
