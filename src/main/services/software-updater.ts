import { execFile } from 'child_process'
import { promisify } from 'util'
import type {
  UpdatableApp,
  UpToDateApp,
  UpdateCheckResult,
  UpdateProgress,
  UpdateResult,
  UpdateSeverity,
} from '../../shared/types'
import { isAdmin } from './elevation'

const execFileAsync = promisify(execFile)

export function cleanOutput(str: string): string {
  // Strip ANSI escape sequences
  let cleaned = str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
  // Handle \r (carriage return) used by spinners: for each line segment,
  // keep only the text after the last \r (since \r overwrites from the start).
  // Lines ending with \r\n produce a trailing empty part after split — use
  // the last non-empty part instead.
  cleaned = cleaned
    .split('\n')
    .map((line) => {
      const parts = line.split('\r')
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].trim()) return parts[i]
      }
      return ''
    })
    .join('\n')
  return cleaned
}

export function computeSeverity(current: string, available: string): UpdateSeverity {
  const parse = (v: string): [number, number, number] | null => {
    const m = v.match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
    if (!m) return null
    return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3] ?? '0')]
  }

  const c = parse(current)
  const a = parse(available)
  if (!c || !a) return 'unknown'

  if (a[0] > c[0]) return 'major'
  if (a[0] === c[0] && a[1] > c[1]) return 'minor'
  if (a[0] === c[0] && a[1] === c[1] && a[2] > c[2]) return 'patch'
  return 'unknown'
}

function emptyResult(
  packageManagerAvailable: boolean,
  packageManagerName: UpdateCheckResult['packageManagerName'],
): UpdateCheckResult {
  return {
    apps: [],
    upToDate: [],
    totalCount: 0,
    majorCount: 0,
    minorCount: 0,
    patchCount: 0,
    packageManagerAvailable,
    packageManagerName,
  }
}

/**
 * Strip a trailing version-like suffix from a display name.
 * Winget display names often include the installed version
 * (e.g. "HandBrake 1.11.0") because that is how the app registers in ARP.
 */
export function stripTrailingVersion(name: string): string {
  return name.replace(/\s+v?\d+[\d.]*\s*$/, '').trim()
}

// ─── Winget (Windows) ───────────────────────────────────────

export function parseWingetUpgradeOutput(stdout: string): UpdatableApp[] {
  const lines = cleanOutput(stdout).split(/\r?\n/)

  // Find the header line
  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/Name\s+Id\s+Version\s+Available\s+Source/i.test(lines[i])) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) return []

  // Separator line (dashes) is right after header
  const separatorIdx = headerIdx + 1
  if (separatorIdx >= lines.length || !/^[-\s]+$/.test(lines[separatorIdx])) return []

  const header = lines[headerIdx]
  const idStart = header.indexOf('Id')
  const versionStart = header.indexOf('Version')
  const availableStart = header.indexOf('Available')
  const sourceStart = header.indexOf('Source')

  if (idStart < 0 || versionStart < 0 || availableStart < 0 || sourceStart < 0) return []

  const apps: UpdatableApp[] = []
  for (let i = separatorIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    // Stop at summary line like "42 upgrades available."
    if (/^\d+\s+upgrade/i.test(line.trim())) break

    const name = line.substring(0, idStart).trim()
    const id = line.substring(idStart, versionStart).trim()
    let version = line.substring(versionStart, availableStart).trim()
    let available = line.substring(availableStart, sourceStart).trim()
    if (version.startsWith('> ')) version = version.slice(2)
    if (version.startsWith('< ')) version = version.slice(2)
    if (available.startsWith('> ')) available = available.slice(2)
    if (available.startsWith('< ')) available = available.slice(2)
    const source = line.substring(sourceStart).trim()

    if (!id || !version || !available) continue
    // When winget reports "< X" for the installed version and X matches the
    // available version, it cannot determine the real version — the app is
    // likely already up to date, so skip it.
    if (version === available) continue

    apps.push({
      id,
      name: stripTrailingVersion(name) || id,
      currentVersion: version,
      availableVersion: available,
      source: source || 'winget',
      severity: computeSeverity(version, available),
      selected: true,
    })
  }
  return apps
}

export function parseWingetListOutput(stdout: string): UpToDateApp[] {
  const lines = cleanOutput(stdout).split(/\r?\n/)

  // Find header — winget list has: Name  Id  Version  Available  Source
  // (Available column may be empty for most apps)
  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/Name\s+Id\s+Version/i.test(lines[i])) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) return []

  const separatorIdx = headerIdx + 1
  if (separatorIdx >= lines.length || !/^[-\s]+$/.test(lines[separatorIdx])) return []

  const header = lines[headerIdx]
  const idStart = header.indexOf('Id')
  const versionStart = header.indexOf('Version')
  // Available and Source columns may or may not exist in winget list
  const availableStart = header.indexOf('Available')
  const sourceStart = header.indexOf('Source')

  if (idStart < 0 || versionStart < 0) return []

  const versionEnd = availableStart > 0 ? availableStart : sourceStart > 0 ? sourceStart : -1

  const apps: UpToDateApp[] = []
  for (let i = separatorIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    if (/^\d+\s+package/i.test(line.trim())) break

    const name = line.substring(0, idStart).trim()
    const id = line.substring(idStart, versionStart).trim()
    let version = versionEnd > 0
      ? line.substring(versionStart, versionEnd).trim()
      : line.substring(versionStart).trim()
    // winget list sometimes prefixes versions with "> " or "< " — strip them
    if (version.startsWith('> ')) version = version.slice(2)
    if (version.startsWith('< ')) version = version.slice(2)
    const source = sourceStart > 0 ? line.substring(sourceStart).trim() : ''

    if (!id || !version || version === 'Unknown') continue
    // Skip ARP entries (not real winget packages)
    if (id.startsWith('ARP\\')) continue

    apps.push({ id, name: stripTrailingVersion(name) || id, version, source: source || 'winget' })
  }
  return apps
}

async function isWingetAvailable(): Promise<boolean> {
  try {
    await execFileAsync('winget', ['--version'], {
      timeout: 10_000,
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

async function checkForUpdatesWinget(): Promise<UpdateCheckResult> {
  const available = await isWingetAvailable()
  if (!available) {
    return emptyResult(false, 'winget')
  }

  try {
    let stdout = ''
    try {
      const result = await execFileAsync(
        'winget',
        ['upgrade', '--accept-source-agreements', '--disable-interactivity'],
        { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      )
      stdout = result.stdout
    } catch (err: any) {
      // winget may exit with non-zero code even on success (e.g. 0x8A150014 = no updates)
      // but still produce valid output in stdout
      if (err?.stdout) {
        stdout = err.stdout
      } else {
        return emptyResult(true, 'winget')
      }
    }

    const apps = parseWingetUpgradeOutput(stdout)

    // Also get the full list of winget-tracked apps to show "up to date" ones
    let upToDate: UpToDateApp[] = []
    try {
      let listStdout = ''
      try {
        const listResult = await execFileAsync(
          'winget',
          ['list', '--source', 'winget', '--accept-source-agreements', '--disable-interactivity'],
          { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
        )
        listStdout = listResult.stdout
      } catch (err: any) {
        if (err?.stdout) listStdout = err.stdout
      }
      if (listStdout) {
        const allApps = parseWingetListOutput(listStdout)
        const outdatedIds = new Set(apps.map((a) => a.id))
        upToDate = allApps.filter((a) => !outdatedIds.has(a.id))
      }
    } catch {
      // Non-critical — just skip the up-to-date list
    }

    return {
      apps,
      upToDate,
      totalCount: apps.length,
      majorCount: apps.filter((a) => a.severity === 'major').length,
      minorCount: apps.filter((a) => a.severity === 'minor').length,
      patchCount: apps.filter((a) => a.severity === 'patch').length,
      packageManagerAvailable: true,
      packageManagerName: 'winget',
    }
  } catch {
    return emptyResult(true, 'winget')
  }
}

const WINGET_UPGRADE_ARGS = [
  '--accept-source-agreements',
  '--accept-package-agreements',
  '--disable-interactivity',
  '--silent',
  '--include-unknown',
]

const SUCCESS_PATTERNS = [
  'successfully installed',
  'successfully upgraded',
  'installer succeeded',
  'no available upgrade',
]

const FAILURE_PATTERNS = [
  'installer failed',
  'no package found',
  'no applicable update',
  'another version of this application',
  'installer aborted',
  'install technology is different',
]

const ELEVATION_HINTS = [
  'access is denied',
  'administrator',
  'elevation',
  'requires admin',
  'run as admin',
  '0x80070005', // E_ACCESSDENIED
]

/** Attempt a single winget upgrade and return {success, output} */
async function attemptWingetUpgrade(
  appId: string,
  extraArgs: string[] = [],
): Promise<{ success: boolean; output: string }> {
  // Validate appId format to prevent argument injection (e.g. --source flags)
  if (!/^[\w][\w.\-]{0,200}$/.test(appId)) {
    return { success: false, output: 'Invalid app ID format' }
  }
  let upgradeStdout = ''
  try {
    const result = await execFileAsync(
      'winget',
      ['upgrade', appId, ...WINGET_UPGRADE_ARGS, ...extraArgs],
      { timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
    )
    upgradeStdout = result.stdout
  } catch (err: any) {
    if (err?.stdout) {
      upgradeStdout = err.stdout
    } else {
      return { success: false, output: err?.message || 'Unknown error' }
    }
  }

  const output = cleanOutput(upgradeStdout).toLowerCase()
  const wasSuccessful = SUCCESS_PATTERNS.some((p) => output.includes(p))
  const hasClearFailure = FAILURE_PATTERNS.some((p) => output.includes(p))

  if (wasSuccessful && !hasClearFailure) {
    return { success: true, output: upgradeStdout }
  }
  // If no success pattern matched, treat as failure — don't assume success on ambiguous output
  return { success: false, output: upgradeStdout }
}

/** Retry a failed upgrade with elevation using PowerShell Start-Process -Verb RunAs */
async function attemptElevatedUpgrade(appId: string): Promise<{ success: boolean; output: string }> {
  // Validate appId format to prevent injection — winget IDs are alphanumeric with dots, dashes, underscores
  if (!/^[\w][\w.\-]{0,200}$/.test(appId)) {
    return { success: false, output: 'Invalid app ID format' }
  }

  try {
    const args = ['upgrade', appId, ...WINGET_UPGRADE_ARGS, '--force'].join(' ')
    // Escape single quotes for PowerShell single-quoted string ('' is the escape for ')
    const safeArgs = args.replace(/'/g, "''")
    // Run winget elevated via Start-Process; -Wait blocks until done, -PassThru gives exit code
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$p = Start-Process winget -ArgumentList '${safeArgs}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`,
      ],
      { timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
    )
    // We can't reliably capture stdout from the elevated process, so verify
    // by checking if winget still lists this app as upgradeable
    const checkResult = await execFileAsync(
      'winget',
      ['upgrade', '--accept-source-agreements', '--disable-interactivity', '--include-unknown'],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
    )
    const stillNeedsUpgrade = checkResult.stdout.includes(appId)
    return {
      success: !stillNeedsUpgrade,
      output: stillNeedsUpgrade ? 'App still needs upgrade after elevated attempt' : stdout,
    }
  } catch (err: any) {
    // UAC was likely denied by user
    return { success: false, output: err?.message || 'Elevated upgrade failed' }
  }
}

/** Concurrency limit for parallel winget upgrades — sequential to avoid winget lock contention */
const WINGET_UPDATE_CONCURRENCY = 1

/** Run a single app through the winget upgrade pipeline: normal → elevated → force */
async function upgradeAppWinget(
  appId: string,
  alreadyAdmin: boolean,
): Promise<{ success: boolean; error?: string }> {
  // First attempt: normal upgrade
  let result = await attemptWingetUpgrade(appId)

  // If failed and not already admin, retry with elevation
  if (!result.success && !alreadyAdmin) {
    const lowerOutput = cleanOutput(result.output).toLowerCase()
    const looksLikeElevationIssue =
      ELEVATION_HINTS.some((h) => lowerOutput.includes(h)) ||
      FAILURE_PATTERNS.some((p) => lowerOutput.includes(p))

    if (looksLikeElevationIssue) {
      result = await attemptElevatedUpgrade(appId)
    }
  }

  // If installer technology changed, skip retries — user must manually uninstall + reinstall
  if (!result.success) {
    const lowerOutput = cleanOutput(result.output).toLowerCase()
    if (lowerOutput.includes('install technology is different')) {
      return { success: false, error: 'Installer type changed — uninstall this app manually then install the new version' }
    }
  }

  // If still failed, retry once with --force (handles version mismatch issues)
  if (!result.success) {
    const retryResult = await attemptWingetUpgrade(appId, ['--force'])
    if (retryResult.success) result = retryResult
  }

  if (result.success) return { success: true }

  const lastLine = cleanOutput(result.output).trim().split('\n').pop() || 'Upgrade failed'
  return { success: false, error: lastLine.length > 200 ? lastLine.slice(0, 200) + '...' : lastLine }
}

async function runUpdatesWinget(
  appIds: string[],
  onProgress: (progress: UpdateProgress) => void,
): Promise<UpdateResult> {
  let succeeded = 0
  let failed = 0
  let completed = 0
  const errors: UpdateResult['errors'] = []
  const alreadyAdmin = isAdmin()
  const total = appIds.length

  // Process in concurrent batches
  for (let batchStart = 0; batchStart < total; batchStart += WINGET_UPDATE_CONCURRENCY) {
    const batch = appIds.slice(batchStart, batchStart + WINGET_UPDATE_CONCURRENCY)

    // Report all in-progress
    for (const appId of batch) {
      onProgress({
        phase: 'updating',
        current: completed + 1,
        total,
        currentApp: appId,
        percent: Math.round((completed / total) * 100),
        status: 'in-progress',
      })
    }

    const results = await Promise.allSettled(
      batch.map((appId) => upgradeAppWinget(appId, alreadyAdmin).then((r) => ({ appId, ...r }))),
    )

    for (const settled of results) {
      completed++
      if (settled.status === 'fulfilled' && settled.value.success) {
        succeeded++
        onProgress({
          phase: 'updating',
          current: completed,
          total,
          currentApp: settled.value.appId,
          percent: Math.round((completed / total) * 100),
          status: 'done',
        })
      } else {
        failed++
        const appId = settled.status === 'fulfilled' ? settled.value.appId : batch[results.indexOf(settled)]
        const reason = settled.status === 'fulfilled'
          ? (settled.value.error || 'Upgrade failed')
          : (settled.reason?.message || 'Unknown error')
        errors.push({ appId, name: appId, reason })
        onProgress({
          phase: 'updating',
          current: completed,
          total,
          currentApp: appId,
          percent: Math.round((completed / total) * 100),
          status: 'failed',
        })
      }
    }
  }

  return { succeeded, failed, errors }
}

// ─── Homebrew (macOS) ───────────────────────────────────────

/** Brew formula/cask name: lowercase alphanumeric, hyphens, dots, underscores, optional tap prefix */
const BREW_ID_PATTERN = /^[a-z0-9][a-z0-9@._+-]*(\/[a-z0-9][a-z0-9@._+-]*)?$/

interface BrewOutdatedFormula {
  name: string
  installed_versions: string[]
  current_version: string
}

interface BrewOutdatedCask {
  name: string
  token: string
  installed_versions: string
  current_version: string
}

interface BrewOutdatedJson {
  formulae: BrewOutdatedFormula[]
  casks: BrewOutdatedCask[]
}

interface BrewInfoFormula {
  name: string
  installed: { version: string }[]
  versions: { stable: string }
}

interface BrewInfoCask {
  token: string
  installed: string | null
  version: string
}

interface BrewInfoJson {
  formulae: BrewInfoFormula[]
  casks: BrewInfoCask[]
}

async function isBrewAvailable(): Promise<boolean> {
  try {
    await execFileAsync('brew', ['--version'], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

export function parseBrewOutdatedJson(stdout: string): UpdatableApp[] {
  let data: BrewOutdatedJson
  try {
    data = JSON.parse(stdout)
  } catch {
    return []
  }

  const apps: UpdatableApp[] = []

  for (const f of data.formulae ?? []) {
    const currentVersion = f.installed_versions?.[0] ?? ''
    apps.push({
      id: f.name,
      name: f.name,
      currentVersion,
      availableVersion: f.current_version,
      source: 'brew',
      severity: computeSeverity(currentVersion, f.current_version),
      selected: true,
    })
  }

  for (const c of data.casks ?? []) {
    const id = c.token || c.name
    const currentVersion = typeof c.installed_versions === 'string'
      ? c.installed_versions
      : ''
    apps.push({
      id,
      name: id,
      currentVersion,
      availableVersion: c.current_version,
      source: 'brew',
      severity: computeSeverity(currentVersion, c.current_version),
      selected: true,
    })
  }

  return apps
}

export function parseBrewInstalledJson(stdout: string): UpToDateApp[] {
  let data: BrewInfoJson
  try {
    data = JSON.parse(stdout)
  } catch {
    return []
  }

  const apps: UpToDateApp[] = []

  for (const f of data.formulae ?? []) {
    const version = f.installed?.[0]?.version ?? f.versions?.stable ?? ''
    if (!version) continue
    apps.push({ id: f.name, name: f.name, version, source: 'brew' })
  }

  for (const c of data.casks ?? []) {
    const version = c.installed ?? c.version ?? ''
    if (!version) continue
    apps.push({ id: c.token, name: c.token, version, source: 'brew' })
  }

  return apps
}

async function checkForUpdatesBrew(): Promise<UpdateCheckResult> {
  const available = await isBrewAvailable()
  if (!available) {
    return emptyResult(false, 'brew')
  }

  try {
    // Get outdated packages as JSON
    let outdatedStdout = ''
    try {
      const result = await execFileAsync(
        'brew',
        ['outdated', '--json=v2'],
        { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      )
      outdatedStdout = result.stdout
    } catch (err: any) {
      if (err?.stdout) {
        outdatedStdout = err.stdout
      } else {
        return emptyResult(true, 'brew')
      }
    }

    const apps = parseBrewOutdatedJson(outdatedStdout)

    // Get all installed packages for the "up to date" list
    let upToDate: UpToDateApp[] = []
    try {
      let infoStdout = ''
      try {
        const infoResult = await execFileAsync(
          'brew',
          ['info', '--json=v2', '--installed'],
          { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
        )
        infoStdout = infoResult.stdout
      } catch (err: any) {
        if (err?.stdout) infoStdout = err.stdout
      }
      if (infoStdout) {
        const allApps = parseBrewInstalledJson(infoStdout)
        const outdatedIds = new Set(apps.map((a) => a.id))
        upToDate = allApps.filter((a) => !outdatedIds.has(a.id))
      }
    } catch {
      // Non-critical — just skip the up-to-date list
    }

    return {
      apps,
      upToDate,
      totalCount: apps.length,
      majorCount: apps.filter((a) => a.severity === 'major').length,
      minorCount: apps.filter((a) => a.severity === 'minor').length,
      patchCount: apps.filter((a) => a.severity === 'patch').length,
      packageManagerAvailable: true,
      packageManagerName: 'brew',
    }
  } catch {
    return emptyResult(true, 'brew')
  }
}

/** Attempt a single brew upgrade */
async function attemptBrewUpgrade(
  name: string,
): Promise<{ success: boolean; error?: string }> {
  if (!BREW_ID_PATTERN.test(name) || name.length > 200) {
    return { success: false, error: 'Invalid package name format' }
  }

  try {
    await execFileAsync(
      'brew',
      ['upgrade', name],
      { timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
    )
    return { success: true }
  } catch (err: any) {
    const output = cleanOutput(err?.stderr || err?.stdout || err?.message || 'Unknown error')
    const lastLine = output.trim().split('\n').pop() || 'Upgrade failed'
    return { success: false, error: lastLine.length > 200 ? lastLine.slice(0, 200) + '...' : lastLine }
  }
}

async function runUpdatesBrew(
  appIds: string[],
  onProgress: (progress: UpdateProgress) => void,
): Promise<UpdateResult> {
  let succeeded = 0
  let failed = 0
  const errors: UpdateResult['errors'] = []
  const total = appIds.length

  // brew doesn't handle parallel upgrades well — run sequentially
  for (let i = 0; i < total; i++) {
    const appId = appIds[i]
    onProgress({
      phase: 'updating',
      current: i + 1,
      total,
      currentApp: appId,
      percent: Math.round((i / total) * 100),
      status: 'in-progress',
    })

    const result = await attemptBrewUpgrade(appId)

    if (result.success) {
      succeeded++
      onProgress({
        phase: 'updating',
        current: i + 1,
        total,
        currentApp: appId,
        percent: Math.round(((i + 1) / total) * 100),
        status: 'done',
      })
    } else {
      failed++
      errors.push({ appId, name: appId, reason: result.error || 'Upgrade failed' })
      onProgress({
        phase: 'updating',
        current: i + 1,
        total,
        currentApp: appId,
        percent: Math.round(((i + 1) / total) * 100),
        status: 'failed',
      })
    }
  }

  return { succeeded, failed, errors }
}

// ─── Linux (apt / dnf / pacman) ─────────────────────────────

type LinuxPM = 'apt' | 'dnf' | 'pacman'

async function detectLinuxPackageManager(): Promise<LinuxPM | null> {
  const candidates: Array<{ name: LinuxPM; paths: string[] }> = [
    { name: 'apt', paths: ['/usr/bin/apt', '/bin/apt'] },
    { name: 'dnf', paths: ['/usr/bin/dnf', '/bin/dnf'] },
    { name: 'pacman', paths: ['/usr/bin/pacman', '/bin/pacman'] },
  ]
  for (const { name, paths } of candidates) {
    for (const p of paths) {
      try {
        await execFileAsync(p, ['--version'], { timeout: 3_000 })
        return name
      } catch { /* not found */ }
    }
  }
  return null
}

/** Linux package name: alphanumeric (mixed case for RPM), hyphens, dots, underscores, plus, colons (for arch qualifiers) */
const LINUX_PKG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.+\-_:]{0,200}$/

// ── apt ──

/**
 * Parse `apt list --upgradable` output.
 * Format: package/distro version_new arch [upgradable from: version_old]
 */
export function parseAptUpgradable(stdout: string): UpdatableApp[] {
  const apps: UpdatableApp[] = []
  for (const line of stdout.split('\n')) {
    // Skip the "Listing..." header and empty lines
    if (!line.trim() || line.startsWith('Listing')) continue
    // e.g. "curl/jammy-updates 7.81.0-1ubuntu1.16 amd64 [upgradable from: 7.81.0-1ubuntu1.15]"
    const match = line.match(/^(\S+?)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s+(\S+?)\]/)
    if (!match) continue
    const [, name, availableVersion, currentVersion] = match
    apps.push({
      id: name,
      name,
      currentVersion,
      availableVersion,
      source: 'apt',
      severity: computeSeverity(currentVersion, availableVersion),
      selected: true,
    })
  }
  return apps
}

/** Parse `dpkg-query -W` output into up-to-date list */
export function parseDpkgInstalled(stdout: string): UpToDateApp[] {
  return stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [name, version] = line.split('\t')
    return { id: name, name, version: version ?? '', source: 'apt' }
  })
}

async function checkForUpdatesApt(): Promise<UpdateCheckResult> {
  try {
    // Refresh package cache (may fail without root — that's OK, uses stale cache)
    try {
      await execFileAsync('/usr/bin/apt-get', ['update', '-qq'], { timeout: 60_000 })
    } catch { /* non-root: use existing cache */ }

    let upgradableStdout = ''
    try {
      const result = await execFileAsync('/usr/bin/apt', ['list', '--upgradable'], {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      })
      upgradableStdout = result.stdout
    } catch (err: any) {
      if (err?.stdout) upgradableStdout = err.stdout
      else return emptyResult(true, 'apt')
    }

    const apps = parseAptUpgradable(upgradableStdout)

    // Get installed packages for the "up to date" list
    let upToDate: UpToDateApp[] = []
    try {
      const { stdout: dpkgOut } = await execFileAsync('/usr/bin/dpkg-query', [
        '-W', '-f', '${Package}\t${Version}\n',
      ], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })
      const allInstalled = parseDpkgInstalled(dpkgOut)
      const outdatedIds = new Set(apps.map((a) => a.id))
      upToDate = allInstalled.filter((a) => !outdatedIds.has(a.id))
    } catch { /* non-critical */ }

    return {
      apps,
      upToDate,
      totalCount: apps.length,
      majorCount: apps.filter((a) => a.severity === 'major').length,
      minorCount: apps.filter((a) => a.severity === 'minor').length,
      patchCount: apps.filter((a) => a.severity === 'patch').length,
      packageManagerAvailable: true,
      packageManagerName: 'apt',
    }
  } catch {
    return emptyResult(true, 'apt')
  }
}

// ── dnf ──

/**
 * Parse `dnf check-update` output.
 * Format: package.arch   version   repo
 * dnf exits with code 100 when updates are available.
 */
export function parseDnfCheckUpdate(stdout: string): UpdatableApp[] {
  const apps: UpdatableApp[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim() || line.startsWith('Last metadata') || line.startsWith('Obsoleting')) continue
    // e.g. "curl.x86_64    7.76.1-23.el9    baseos"
    // Use greedy match so we split on the LAST dot (arch never contains dots)
    const match = line.match(/^(\S+)\.(\w+)\s+(\S+)\s+(\S+)/)
    if (!match) continue
    const [, nameWithoutArch, , availableVersion, repo] = match
    apps.push({
      id: nameWithoutArch,
      name: nameWithoutArch,
      currentVersion: '', // filled in below
      availableVersion,
      source: repo || 'dnf',
      severity: 'unknown',
      selected: true,
    })
  }
  return apps
}

async function checkForUpdatesDnf(): Promise<UpdateCheckResult> {
  try {
    // dnf check-update exits 100 when updates are available
    let checkStdout = ''
    try {
      const result = await execFileAsync('/usr/bin/dnf', ['check-update', '-q'], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })
      checkStdout = result.stdout
    } catch (err: any) {
      checkStdout = err?.stdout ?? ''
    }

    const apps = parseDnfCheckUpdate(checkStdout)

    // Get installed versions to fill in currentVersion and build up-to-date list
    let upToDate: UpToDateApp[] = []
    try {
      const { stdout: rpmOut } = await execFileAsync('/usr/bin/rpm', [
        '-qa', '--queryformat', '%{NAME}\t%{VERSION}-%{RELEASE}\n',
      ], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })

      const installedMap = new Map<string, string>()
      for (const line of rpmOut.trim().split('\n')) {
        if (!line.trim()) continue
        const [name, version] = line.split('\t')
        installedMap.set(name, version ?? '')
      }

      // Fill in current versions and compute severity
      for (const app of apps) {
        const current = installedMap.get(app.id)
        if (current) {
          app.currentVersion = current
          app.severity = computeSeverity(current, app.availableVersion)
        }
      }

      // Build up-to-date list
      const outdatedIds = new Set(apps.map((a) => a.id))
      for (const [name, version] of installedMap) {
        if (!outdatedIds.has(name)) {
          upToDate.push({ id: name, name, version, source: 'dnf' })
        }
      }
    } catch { /* non-critical */ }

    return {
      apps,
      upToDate,
      totalCount: apps.length,
      majorCount: apps.filter((a) => a.severity === 'major').length,
      minorCount: apps.filter((a) => a.severity === 'minor').length,
      patchCount: apps.filter((a) => a.severity === 'patch').length,
      packageManagerAvailable: true,
      packageManagerName: 'dnf',
    }
  } catch {
    return emptyResult(true, 'dnf')
  }
}

// ── pacman ──

/**
 * Parse `pacman -Qu` output.
 * Format: package old_version -> new_version
 */
export function parsePacmanQu(stdout: string): UpdatableApp[] {
  const apps: UpdatableApp[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    // e.g. "curl 7.87.0-1 -> 7.88.0-1"
    const match = line.match(/^(\S+)\s+(\S+)\s+->\s+(\S+)/)
    if (!match) continue
    const [, name, currentVersion, availableVersion] = match
    apps.push({
      id: name,
      name,
      currentVersion,
      availableVersion,
      source: 'pacman',
      severity: computeSeverity(currentVersion, availableVersion),
      selected: true,
    })
  }
  return apps
}

async function checkForUpdatesPacman(): Promise<UpdateCheckResult> {
  try {
    // Sync database first
    try {
      await execFileAsync('/usr/bin/pacman', ['-Sy'], { timeout: 60_000 })
    } catch { /* may need root — use stale db */ }

    let quStdout = ''
    try {
      const result = await execFileAsync('/usr/bin/pacman', ['-Qu'], {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      })
      quStdout = result.stdout
    } catch (err: any) {
      // pacman -Qu exits 1 when no updates available
      if (err?.stdout) quStdout = err.stdout
    }

    const apps = parsePacmanQu(quStdout)

    // Get all installed for up-to-date list
    let upToDate: UpToDateApp[] = []
    try {
      const { stdout: qOut } = await execFileAsync('/usr/bin/pacman', ['-Q'], {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      })
      const outdatedIds = new Set(apps.map((a) => a.id))
      for (const line of qOut.trim().split('\n')) {
        if (!line.trim()) continue
        const [name, version] = line.split(' ')
        if (name && !outdatedIds.has(name)) {
          upToDate.push({ id: name, name, version: version ?? '', source: 'pacman' })
        }
      }
    } catch { /* non-critical */ }

    return {
      apps,
      upToDate,
      totalCount: apps.length,
      majorCount: apps.filter((a) => a.severity === 'major').length,
      minorCount: apps.filter((a) => a.severity === 'minor').length,
      patchCount: apps.filter((a) => a.severity === 'patch').length,
      packageManagerAvailable: true,
      packageManagerName: 'pacman',
    }
  } catch {
    return emptyResult(true, 'pacman')
  }
}

// ── Linux: check dispatcher ──

async function checkForUpdatesLinux(): Promise<UpdateCheckResult> {
  const pm = await detectLinuxPackageManager()
  if (!pm) return emptyResult(false, null)
  if (pm === 'apt') return checkForUpdatesApt()
  if (pm === 'dnf') return checkForUpdatesDnf()
  return checkForUpdatesPacman()
}

// ── Linux: run updates ──

async function attemptLinuxUpgrade(
  pm: LinuxPM,
  appId: string,
): Promise<{ success: boolean; error?: string }> {
  if (!LINUX_PKG_PATTERN.test(appId)) {
    return { success: false, error: 'Invalid package name format' }
  }

  try {
    if (pm === 'apt') {
      await execFileAsync('/usr/bin/apt-get', ['install', '-y', '-qq', appId], {
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      })
    } else if (pm === 'dnf') {
      await execFileAsync('/usr/bin/dnf', ['upgrade', '-y', '-q', appId], {
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      })
    } else {
      await execFileAsync('/usr/bin/pacman', ['-S', '--noconfirm', appId], {
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      })
    }
    return { success: true }
  } catch (err: any) {
    const output = cleanOutput(err?.stderr || err?.stdout || err?.message || 'Unknown error')
    const lastLine = output.trim().split('\n').pop() || 'Upgrade failed'
    return { success: false, error: lastLine.length > 200 ? lastLine.slice(0, 200) + '...' : lastLine }
  }
}

async function runUpdatesLinux(
  appIds: string[],
  onProgress: (progress: UpdateProgress) => void,
): Promise<UpdateResult> {
  const pm = await detectLinuxPackageManager()
  if (!pm) return { succeeded: 0, failed: 0, errors: [] }

  let succeeded = 0
  let failed = 0
  const errors: UpdateResult['errors'] = []
  const total = appIds.length

  // Run sequentially — apt/dnf/pacman don't handle parallel installs
  for (let i = 0; i < total; i++) {
    const appId = appIds[i]
    onProgress({
      phase: 'updating',
      current: i + 1,
      total,
      currentApp: appId,
      percent: Math.round((i / total) * 100),
      status: 'in-progress',
    })

    const result = await attemptLinuxUpgrade(pm, appId)

    if (result.success) {
      succeeded++
      onProgress({
        phase: 'updating',
        current: i + 1,
        total,
        currentApp: appId,
        percent: Math.round(((i + 1) / total) * 100),
        status: 'done',
      })
    } else {
      failed++
      errors.push({ appId, name: appId, reason: result.error || 'Upgrade failed' })
      onProgress({
        phase: 'updating',
        current: i + 1,
        total,
        currentApp: appId,
        percent: Math.round(((i + 1) / total) * 100),
        status: 'failed',
      })
    }
  }

  return { succeeded, failed, errors }
}

// ─── Platform-dispatched exports ────────────────────────────

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (process.platform === 'darwin') return checkForUpdatesBrew()
  if (process.platform === 'win32') return checkForUpdatesWinget()
  if (process.platform === 'linux') return checkForUpdatesLinux()
  return emptyResult(false, null)
}

export async function runUpdates(
  appIds: string[],
  onProgress: (progress: UpdateProgress) => void,
): Promise<UpdateResult> {
  if (process.platform === 'darwin') return runUpdatesBrew(appIds, onProgress)
  if (process.platform === 'win32') return runUpdatesWinget(appIds, onProgress)
  if (process.platform === 'linux') return runUpdatesLinux(appIds, onProgress)
  return { succeeded: 0, failed: 0, errors: [] }
}

/** Validate an app ID for the current platform's package manager */
export function isValidAppId(id: string): boolean {
  if (process.platform === 'darwin') return BREW_ID_PATTERN.test(id) && id.length <= 200
  if (process.platform === 'linux') return LINUX_PKG_PATTERN.test(id)
  return /^[\w][\w.\-]{0,200}$/.test(id)
}
