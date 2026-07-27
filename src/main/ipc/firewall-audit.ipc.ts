import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../../shared/channels'
import type { WindowGetter } from './index'
import type {
  FirewallRule,
  FirewallScanResult,
  FirewallApplyResult,
  FirewallScanProgress,
  FirewallProfile,
  FirewallSignatureStatus,
  FirewallIssue,
  FirewallRiskLevel,
  FirewallAction,
} from '../../shared/types'
import { psUtf8, spawnTrackedLines } from '../services/exec-utf8'

const execFileAsync = promisify(execFile)

function psArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)]
}
const PS_OPTS = { timeout: 120_000, maxBuffer: 50 * 1024 * 1024, windowsHide: true }

// The scan streams its results, so a generous ceiling costs nothing on a
// healthy system and only bounds the pathological case (a machine where the
// bulk filter enumeration is denied and every rule falls back to a ~240 ms
// association query).
const SCAN_TIMEOUT_MS = 300_000

/**
 * Build an actionable error for a failed PowerShell run.
 *
 * Node rejects with "Command failed: <the entire command line>", which for
 * these scripts means kilobytes of echoed PowerShell with the actual reason
 * nowhere in it (issue #246). Prefer stderr, fall back to the exit code, and
 * never include the script itself.
 */
function powerShellError(context: string, code: number | null, stderr: string): Error {
  const detail = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join(' ')
  if (detail) return new Error(`${context}: ${detail}`)
  return new Error(`${context}: PowerShell exited with code ${code ?? 'unknown'}`)
}

// User-defined firewall rule names can contain spaces, parentheses, and
// other printable characters (e.g. "Microsoft Edge (mDNS-In)").  We
// interpolate names into single-quoted PowerShell strings with `'` doubled,
// so that escape neutralizes injection — the regex just needs to block
// control characters, embedded null/newlines, and the pipe delimiter we
// use in scan output.
const RULE_NAME_RE = /^[^\x00-\x1f\x7f|]{1,512}$/

function parseProfiles(raw: string): FirewallProfile[] {
  // PowerShell renders the Profile flag enum as "Domain, Private" or "Any".
  if (!raw) return []
  if (raw.toLowerCase().trim() === 'any') return ['Any']
  const parts = raw.split(',').map((p) => p.trim())
  const out: FirewallProfile[] = []
  for (const p of parts) {
    if (p === 'Domain' || p === 'Private' || p === 'Public') out.push(p)
  }
  return out
}

function parseSignature(raw: string): FirewallSignatureStatus {
  switch (raw) {
    case 'signed': return 'signed'
    case 'unsigned': return 'unsigned'
    case 'unknown': return 'unknown'
    default: return 'not-applicable'
  }
}

// Built-in Windows rules carry one of two unresolved resource references in
// their description or group field (Windows tried to resolve via MUI and
// failed, so we see the raw reference string). Either form is a reliable
// Microsoft/packaged-app signal even when the rule has no program filter:
//
//   1. Classic MUI resource: "@FirewallAPI.dll,-25000",
//      "@%systemroot%\system32\vmms.exe,-210" — used by Win32 system rules.
//   2. AppX/UWP package resource: "@{Pkg_Ver_arch__pub?ms-resource://...}" —
//      used by packaged apps (Desktop App Web Viewer, OOBE, etc.). UWP apps
//      run inside an AppContainer sandbox so "broad-scope" doesn't apply
//      the same way as for unrestricted Win32 binaries.
//
// We also check the Group field because some rules (e.g. "Game Bar") have
// the resolved literal description but still carry a resource-reference
// Group, and we trust the AppX `Package` field on the application filter
// when set — that means a sandboxed packaged app, regardless of description.
const MUI_RESOURCE_RE = /^@[^,]+\.(?:dll|exe|mui),-\d+(?:;.*)?$/i
const APPX_RESOURCE_RE = /^@\{[^}]+\?ms-resource:\/\/[^}]+\}$/i

function looksLikeResourceRef(s: string): boolean {
  const t = s.trim()
  return MUI_RESOURCE_RE.test(t) || APPX_RESOURCE_RE.test(t)
}

export function isBuiltinRule(args: {
  description: string
  group: string
  isManaged: boolean
  isSystemPath: boolean
}): boolean {
  if (args.isSystemPath) return true
  if (args.isManaged) return true
  return looksLikeResourceRef(args.description) || looksLikeResourceRef(args.group)
}

// Curated allowlist of well-known, legitimate services whose rules require a
// broad remote scope by design and would otherwise surface as noisy
// "any-remote" medium findings. These aren't caught by isBuiltinRule because
// they carry no program filter (mDNS), live outside the system/Program Files
// tree (Zoom in AppData), or are third-party managed rules with no MUI/AppX
// resource reference (Tailscale, HNS container networking).
//
// An entry matches only when EVERY predicate it specifies matches, so an entry
// is as tight as the identifying facts we have — a bare port match is
// deliberately protocol-qualified, and program-based entries pin the full
// binary tail. Matching downgrades the rule to the same trust level as a
// built-in: only a stale program path remains a finding.
type KnownGoodEntry = {
  label: string
  nameRe?: RegExp
  protocol?: string
  localPort?: string
  programRe?: RegExp
}

const KNOWN_GOOD_SERVICES: KnownGoodEntry[] = [
  // Multicast DNS — link-local service discovery, inherently Any-remote.
  { label: 'mDNS', protocol: 'UDP', localPort: '5353' },
  // LLMNR — legacy name resolution, same link-local shape as mDNS.
  { label: 'LLMNR', protocol: 'UDP', localPort: '5355' },
  // Tailscale mesh VPN — peer set is dynamic, so Any/Any/Any is by design.
  { label: 'Tailscale', nameRe: /^Tailscale(-In)?$/i },
  // Docker Desktop / Windows containers host networking service. Rule names
  // are GUID-suffixed, e.g. "HNS Container Networking - DNS (UDP-In) - <GUID>".
  { label: 'HNS Container Networking', nameRe: /^HNS Container Networking\b/i },
  // Zoom real-time media — UDP port range, peer-to-peer to Any remote.
  { label: 'Zoom', programRe: /[\\/]Zoom[\\/]bin[\\/]Zoom\.exe$/i },
]

export function isKnownGoodService(args: {
  name: string
  displayName: string
  protocol: string
  localPort: string
  programResolved: string
}): boolean {
  return KNOWN_GOOD_SERVICES.some((entry) => {
    if (entry.protocol && args.protocol.toUpperCase() !== entry.protocol.toUpperCase()) return false
    if (entry.localPort && args.localPort !== entry.localPort) return false
    if (entry.nameRe && !entry.nameRe.test(args.name) && !entry.nameRe.test(args.displayName)) return false
    if (entry.programRe && !entry.programRe.test(args.programResolved)) return false
    // Reject an entry that specified nothing (defensive — never matches on emptiness).
    return !!(entry.protocol || entry.localPort || entry.nameRe || entry.programRe)
  })
}

export function classifyRule(
  raw: {
    program: string
    programResolved: string
    programExists: boolean
    signature: FirewallSignatureStatus
    profiles: FirewallProfile[]
    localPort: string
    remoteAddress: string
    builtin: boolean
    knownGood: boolean
  }
): { issues: FirewallIssue[]; risk: FirewallRiskLevel } {
  const issues: FirewallIssue[] = []

  const hasProgram = !!raw.programResolved

  // Stale (program path no longer exists) is a real finding even for built-ins —
  // a Windows feature was uninstalled but the firewall rule wasn't cleaned up.
  if (hasProgram && !raw.programExists) issues.push('stale')

  if (raw.builtin) {
    // Microsoft-shipped rules are designed to accept Any remote / Any port on
    // Public profiles (IPv6 routing, Wi-Fi Direct, CDP, etc.) and always point
    // at a signed system binary. Flagging these as high/medium produces
    // guidance that breaks features when followed.
    let risk: FirewallRiskLevel = 'low'
    if (issues.includes('stale')) risk = 'high'
    return { issues, risk }
  }

  // Program-integrity findings (unsigned) apply even to known-good services:
  // the allowlist attests to the service's expected scope, not to the identity
  // of whatever binary a rule with that shape happens to point at. A spoofed
  // rule matching the allowlist but backed by an unsigned binary must still
  // surface.
  if (hasProgram && raw.programExists && raw.signature === 'unsigned') issues.push('unsigned')

  const isAnyRemote = !raw.remoteAddress || raw.remoteAddress.toLowerCase() === 'any'
  const isAnyPort = !raw.localPort || raw.localPort.toLowerCase() === 'any'
  const hitsPublic = raw.profiles.includes('Public') || raw.profiles.includes('Any')

  // Known-good services (mDNS, Tailscale, container networking, Zoom) require a
  // broad remote scope by design, so suppress ONLY the scope findings — not the
  // integrity checks above.
  if (!raw.knownGood) {
    if (isAnyRemote && isAnyPort && hitsPublic) issues.push('broad-scope')
    else if (isAnyRemote) issues.push('any-remote')
  }

  let risk: FirewallRiskLevel = 'low'
  if (issues.includes('stale') || issues.includes('broad-scope')) risk = 'high'
  else if (issues.includes('unsigned') || issues.includes('any-remote')) risk = 'medium'

  return { issues, risk }
}

// Parse a single RULE| line from the PowerShell scanner.  Exported for tests.
export function parseRuleLine(line: string): FirewallRule | null {
  // Format: RULE|name|display|description|group|profiles|protocol|localPort|remoteAddress|program|programResolved|exists|signature|isSystemPath|isManaged|enabled
  if (!line.startsWith('RULE|')) return null
  const parts = line.split('|')
  if (parts.length < 16) return null

  const name = parts[1]
  if (!name) return null

  const description = parts[3] || ''
  const group = parts[4] || ''
  const profiles = parseProfiles(parts[5])
  const programResolved = parts[10]
  const programExists = parts[11].trim().toLowerCase() === 'true'
  const signature = parseSignature(parts[12].trim().toLowerCase())
  const isSystemPath = parts[13].trim().toLowerCase() === 'true'
  const isManaged = parts[14].trim().toLowerCase() === 'true'
  const enabled = parts[15].trim().toLowerCase() === 'true'

  const localPort = parts[7] || 'Any'
  const remoteAddress = parts[8] || 'Any'
  const protocol = parts[6] || 'Any'
  const builtin = isBuiltinRule({ description, group, isManaged, isSystemPath })
  const knownGood = isKnownGoodService({
    name,
    displayName: parts[2] || name,
    protocol,
    localPort,
    programResolved,
  })

  const { issues, risk } = classifyRule({
    program: parts[9],
    programResolved,
    programExists,
    signature,
    profiles,
    localPort,
    remoteAddress,
    builtin,
    knownGood,
  })

  return {
    name,
    displayName: parts[2] || name,
    description,
    group,
    profiles,
    protocol,
    localPort,
    remoteAddress,
    program: parts[9] || '',
    programResolved,
    programExists,
    signature,
    builtin,
    enabled,
    issues,
    risk,
    selected: false,
  }
}

export async function scanFirewallRules(
  onProgress?: (data: FirewallScanProgress) => void
): Promise<FirewallScanResult> {
  if (process.platform !== 'win32') {
    return { rules: [], totalCount: 0, staleCount: 0, unsignedCount: 0, broadScopeCount: 0 }
  }

  onProgress?.({ phase: 'enumerating', current: 0, total: 0, currentRule: 'Enumerating firewall rules...' })

  // Pull all enabled inbound Allow rules and stream a single line per rule.
  // Skip Authenticode checks for system-owned paths (Windows / Program Files)
  // since they're invariably signed and the cmdlet is the slow part.
  const script = String.raw`
    $ErrorActionPreference = 'SilentlyContinue'
    $rules = @(Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' })
    $total = $rules.Count
    Write-Output "TOTAL|$total"
    $i = 0
    # Resolving a rule's filters through the CIM association ("$r | Get-NetFirewallPortFilter")
    # costs ~80 ms per call, and we need three per rule. Past ~500 inbound rules
    # that alone exceeds the caller's timeout, and because $ErrorActionPreference
    # is SilentlyContinue the kill produced no stderr at all — the UI showed only
    # the echoed script (issue #246). Enumerate each filter class once instead and
    # join on InstanceID, which is the rule's Name. -All can fail outright or come
    # back partial when the process lacks rights on a policy store, so any rule
    # missing from an index still falls back to its own association query.
    $appIdx = @{}
    $portIdx = @{}
    $addrIdx = @{}
    foreach ($f in @(Get-NetFirewallApplicationFilter -All)) { if ($f.InstanceID) { $appIdx[[string]$f.InstanceID] = $f } }
    foreach ($f in @(Get-NetFirewallPortFilter -All)) { if ($f.InstanceID) { $portIdx[[string]$f.InstanceID] = $f } }
    foreach ($f in @(Get-NetFirewallAddressFilter -All)) { if ($f.InstanceID) { $addrIdx[[string]$f.InstanceID] = $f } }
    # Authenticode verification does certificate revocation lookups that can block
    # on the network, and multiple rules routinely point at the same binary, so
    # memoize the verdict per path. Hashtable keys are case-insensitive, which is
    # what we want for Windows paths.
    $sigCache = @{}
    # Append the directory separator so StartsWith matches on a directory boundary.
    # Without this, "C:\WindowsTemp\evil.exe" would match "C:\Windows" and be wrongly
    # treated as system-signed, suppressing the unsigned-binary finding.
    $sep = [IO.Path]::DirectorySeparatorChar
    $sysRoot = [Environment]::GetFolderPath('Windows')
    $pf = [Environment]::GetFolderPath('ProgramFiles')
    $pfx86 = [System.Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ($sysRoot) { $sysRoot = $sysRoot.TrimEnd($sep) + $sep }
    if ($pf) { $pf = $pf.TrimEnd($sep) + $sep }
    if ($pfx86) { $pfx86 = $pfx86.TrimEnd($sep) + $sep }
    foreach ($r in $rules) {
      $i++
      $key = if ($r.InstanceID) { [string]$r.InstanceID } else { [string]$r.Name }
      $app = $appIdx[$key]
      $port = $portIdx[$key]
      $addr = $addrIdx[$key]
      try {
        if (-not $app) { $app = $r | Get-NetFirewallApplicationFilter }
        if (-not $port) { $port = $r | Get-NetFirewallPortFilter }
        if (-not $addr) { $addr = $r | Get-NetFirewallAddressFilter }
      } catch { continue }

      $programRaw = if ($app -and $app.Program) { [string]$app.Program } else { '' }
      # Package SID for AppX/UWP rules (e.g. "S-1-15-2-..."). When set, the
      # rule applies to a sandboxed packaged app — Game Bar, Microsoft Store,
      # and similar Win32WebViewHost / OOBE rules all have this populated even
      # when the description is the resolved literal display name.
      $packageRaw = if ($app -and $app.Package) { ([string]$app.Package) -replace '\|', ' ' } else { '' }
      # Owner SID falls back when Package is missing — every Store-installed
      # AppX rule has an Owner set, while manually-created rules (Defender
      # Firewall GUI / netsh) typically don't. We collapse to a single
      # "managed/packaged" boolean to keep the output line format tight.
      $ownerRaw = if ($r.Owner) { [string]$r.Owner } else { '' }
      $isManaged = ($packageRaw -ne '') -or ($ownerRaw -ne '')
      $localPort  = if ($port -and $port.LocalPort) { (@($port.LocalPort) -join ',') } else { 'Any' }
      $protocol   = if ($port -and $port.Protocol) { [string]$port.Protocol } else { 'Any' }
      $remoteAddr = if ($addr -and $addr.RemoteAddress) { (@($addr.RemoteAddress) -join ',') } else { 'Any' }

      $programResolved = ''
      $exists = $false
      $signed = ''
      $isSystemPath = $false
      if ($programRaw -and $programRaw -ne 'Any' -and $programRaw -ne 'System') {
        try { $programResolved = [System.Environment]::ExpandEnvironmentVariables($programRaw) } catch { $programResolved = $programRaw }
        if (Test-Path -LiteralPath $programResolved -PathType Leaf) {
          $exists = $true
          if ($sysRoot -and $programResolved.StartsWith($sysRoot, 'OrdinalIgnoreCase')) { $isSystemPath = $true }
          if (-not $isSystemPath -and $pf -and $programResolved.StartsWith($pf, 'OrdinalIgnoreCase')) { $isSystemPath = $true }
          if (-not $isSystemPath -and $pfx86 -and $programResolved.StartsWith($pfx86, 'OrdinalIgnoreCase')) { $isSystemPath = $true }
          if ($isSystemPath) {
            $signed = 'signed'
          } elseif ($sigCache.ContainsKey($programResolved)) {
            $signed = $sigCache[$programResolved]
          } else {
            try {
              $sig = Get-AuthenticodeSignature -LiteralPath $programResolved
              if ($sig.Status -eq 'Valid') { $signed = 'signed' }
              elseif ($sig.Status -eq 'NotSigned') { $signed = 'unsigned' }
              else { $signed = 'unknown' }
            } catch { $signed = 'unknown' }
            $sigCache[$programResolved] = $signed
          }
        }
      }

      $name = ([string]$r.Name) -replace '\|', ' '
      $disp = if ($r.DisplayName) { ([string]$r.DisplayName) -replace '\|', ' ' } else { $name }
      $descRaw = if ($r.Description) { [string]$r.Description } else { '' }
      $desc = $descRaw -replace '\|', ' ' -replace '\r?\n', ' '
      $grp  = if ($r.Group) { ([string]$r.Group) -replace '\|', ' ' } else { '' }
      $prof = [string]$r.Profile

      Write-Output "RULE|$name|$disp|$desc|$grp|$prof|$protocol|$localPort|$remoteAddr|$programRaw|$programResolved|$exists|$signed|$isSystemPath|$isManaged|true"

      if (($i % 25) -eq 0) {
        Write-Output "PROG|$i|$total|$disp"
      }
    }
  `

  const rules: FirewallRule[] = []
  let total = 0

  // Consume stdout line by line rather than buffering it: the PROG markers the
  // script emits only drive the progress bar if they arrive while the scan is
  // still running, and anything already parsed survives a timeout.
  const { stderr, code, timedOut } = await spawnTrackedLines(
    'powershell',
    psArgs(script),
    (rawLine) => {
      const line = rawLine.trim()
      if (!line) return
      if (line.startsWith('TOTAL|')) {
        const n = parseInt(line.split('|')[1], 10)
        if (!Number.isNaN(n)) total = n
        return
      }
      if (line.startsWith('PROG|')) {
        const parts = line.split('|')
        const cur = parseInt(parts[1], 10)
        const tot = parseInt(parts[2], 10)
        const ruleName = parts[3] ?? ''
        if (!Number.isNaN(cur) && !Number.isNaN(tot)) {
          onProgress?.({ phase: 'classifying', current: cur, total: tot, currentRule: ruleName })
        }
        return
      }
      const parsed = parseRuleLine(line)
      if (parsed) rules.push(parsed)
    },
    { timeout: SCAN_TIMEOUT_MS }
  )

  // Only treat the run as a failure when it produced nothing usable — a scan
  // that streamed rules before being cut short is reported as truncated.
  if (rules.length === 0) {
    if (timedOut) {
      throw new Error(
        `Firewall scan timed out after ${Math.round(SCAN_TIMEOUT_MS / 1000)}s without returning any rules. ` +
          'Check that the Windows Defender Firewall (MpsSvc) and Base Filtering Engine (BFE) services are running.'
      )
    }
    if (code !== 0) throw powerShellError('Firewall scan failed', code, stderr)
  }

  const staleCount = rules.filter((r) => r.issues.includes('stale')).length
  const unsignedCount = rules.filter((r) => r.issues.includes('unsigned')).length
  const broadScopeCount = rules.filter((r) => r.issues.includes('broad-scope')).length

  return {
    rules,
    totalCount: total || rules.length,
    staleCount,
    unsignedCount,
    broadScopeCount,
    truncated: timedOut || (total > 0 && rules.length < total),
  }
}

export async function applyFirewallChanges(
  changes: { name: string; action: FirewallAction }[]
): Promise<FirewallApplyResult> {
  if (!Array.isArray(changes) || changes.length === 0) {
    return { succeeded: 0, failed: 0, errors: [] }
  }
  if (process.platform !== 'win32') {
    return { succeeded: 0, failed: changes.length, errors: changes.map((c) => ({ name: c.name, displayName: c.name, reason: 'Firewall audit is Windows-only' })) }
  }

  // Validate every name against a strict allowlist before interpolating.
  for (const c of changes) {
    if (typeof c.name !== 'string' || !RULE_NAME_RE.test(c.name)) {
      return { succeeded: 0, failed: changes.length, errors: [{ name: c.name ?? '', displayName: c.name ?? '', reason: 'Invalid rule name' }] }
    }
    if (c.action !== 'disable' && c.action !== 'delete') {
      return { succeeded: 0, failed: changes.length, errors: [{ name: c.name, displayName: c.name, reason: 'Invalid action' }] }
    }
  }

  const lines = changes.map((c) => {
    const safeName = c.name.replace(/'/g, "''")
    const cmd = c.action === 'delete' ? 'Remove-NetFirewallRule' : 'Set-NetFirewallRule'
    const extra = c.action === 'delete' ? '' : ' -Enabled False'
    return `
try {
  $rule = Get-NetFirewallRule -Name '${safeName}' -ErrorAction Stop
  $dn = $rule.DisplayName
  ${cmd} -Name '${safeName}'${extra} -ErrorAction Stop
  Write-Output "OK|${safeName}|$dn"
} catch {
  Write-Output "FAIL|${safeName}|${safeName}|$($_.Exception.Message -replace '\\|', ' ' -replace '\\r?\\n', ' ')"
}`
  })

  const script = lines.join('\n')

  let succeeded = 0
  let failed = 0
  const errors: { name: string; displayName: string; reason: string }[] = []

  try {
    const { stdout } = await execFileAsync('powershell', psArgs(script), {
      ...PS_OPTS,
      timeout: changes.length * 5_000 + 30_000,
    })

    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim()
      if (line.startsWith('OK|')) {
        succeeded++
      } else if (line.startsWith('FAIL|')) {
        failed++
        const parts = line.split('|')
        errors.push({
          name: parts[1] || '',
          displayName: parts[2] || '',
          reason: parts[3] || 'Unknown error',
        })
      }
    }
  } catch (err) {
    failed = changes.length - succeeded
    // Same trap as the scan: the raw rejection message is the whole echoed
    // script. Use the stderr/exit code Node attaches to it instead.
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: number | string; killed?: boolean }
    const reason = e?.killed
      ? 'PowerShell timed out while applying firewall changes'
      : powerShellError(
          'Failed to apply firewall changes',
          typeof e?.code === 'number' ? e.code : null,
          e?.stderr ?? ''
        ).message
    errors.push({ name: '', displayName: '', reason })
  }

  return { succeeded, failed, errors }
}

export function registerFirewallAuditIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.FIREWALL_SCAN, () => scanFirewallRules((data) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.FIREWALL_PROGRESS, data)
  }))

  ipcMain.handle(IPC.FIREWALL_APPLY, async (_event, changes: { name: string; action: FirewallAction }[]) => {
    if (!Array.isArray(changes)) return { succeeded: 0, failed: 0, errors: [] }
    return applyFirewallChanges(changes)
  })
}
