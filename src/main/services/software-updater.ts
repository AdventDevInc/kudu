import { execFile } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type {
  PackageManagerName,
  PackageManagerStatus,
  UpdatableApp,
  UpToDateApp,
  UpdateCheckResult,
  UpdateProgress,
  UpdateRequestItem,
  UpdateResult,
  UpdateSeverity,
  WindowsPackageManager
} from '../../shared/types'
import { isAdmin } from './elevation'
import { psUtf8 } from './exec-utf8'
import { getSettings } from './settings-store'

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

/**
 * Build an empty check result. `error` records why the scan produced nothing
 * (CLI missing, timed out, crashed) so the UI can distinguish "nothing is
 * outdated" from "we never got an answer" — see #462.
 */
function emptyResult(
  packageManagerAvailable: boolean,
  packageManagerName: PackageManagerName | null,
  error?: string
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
    managers: packageManagerName
      ? [
          {
            name: packageManagerName,
            available: packageManagerAvailable,
            outdatedCount: 0,
            ...(error ? { error } : {})
          }
        ]
      : []
  }
}

/** Last non-empty line of a CLI's output, trimmed for display. */
function lastOutputLine(raw: string, fallback: string): string {
  const line = cleanOutput(raw).trim().split('\n').filter(Boolean).pop()?.trim() || fallback
  return line.length > 200 ? line.slice(0, 200) + '…' : line
}

/** Describe an execFile rejection: timeout, missing binary, or last output line. */
function describeExecError(err: any, fallback: string): string {
  if (err?.killed || err?.signal) return 'timed out'
  if (err?.code === 'ENOENT') return 'command not found'
  return lastOutputLine(err?.stderr || err?.stdout || err?.message || '', fallback)
}

/** Build a single-manager check result with derived counts + status. */
function buildResult(
  name: PackageManagerName,
  apps: UpdatableApp[],
  upToDate: UpToDateApp[],
  error?: string
): UpdateCheckResult {
  return {
    apps,
    upToDate,
    totalCount: apps.length,
    majorCount: apps.filter((a) => a.severity === 'major').length,
    minorCount: apps.filter((a) => a.severity === 'minor').length,
    patchCount: apps.filter((a) => a.severity === 'patch').length,
    packageManagerAvailable: true,
    packageManagerName: name,
    managers: [{ name, available: true, outdatedCount: apps.length, ...(error ? { error } : {}) }]
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

/** A column of a winget table: its header text and start display column. */
interface WingetColumn {
  label: string
  start: number
}

/**
 * Codepoint ranges the console renders two cells wide (CJK, Hangul, kana,
 * fullwidth forms, emoji). Winget pads its table to display columns, so a
 * Japanese header like `名前  ID  バージョン` occupies far more terminal
 * columns than it does UTF-16 code units — slicing rows by string index would
 * shear every column after it.
 */
const WIDE_CHAR_RANGES: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd]
]

/** Terminal cells a single codepoint occupies: 0 (combining), 1, or 2. */
function charWidth(code: number): number {
  if (code >= 0x0300 && code <= 0x036f) return 0
  for (const [lo, hi] of WIDE_CHAR_RANGES) {
    if (code >= lo && code <= hi) return 2
  }
  return 1
}

/** Terminal cells a string occupies. */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch.codePointAt(0) as number)
  return width
}

/**
 * Slice a line by *display* columns rather than string indexes. A wide
 * character straddling a boundary is kept with the column it starts in.
 */
export function sliceByDisplayColumns(line: string, startCol: number, endCol: number): string {
  let col = 0
  let out = ''
  for (const ch of line) {
    if (col >= endCol) break
    if (col >= startCol) out += ch
    col += charWidth(ch.codePointAt(0) as number)
  }
  return out
}

interface WingetTable {
  /** Column offsets, left to right, as laid out in the header line. */
  columns: WingetColumn[]
  /** Data rows (everything after the separator up to the first summary line). */
  rows: string[]
}

/**
 * English column headers, used to map columns by name when available. Winget
 * localises its headers (e.g. `Nome  ID  Versione  Disponibile  Origine` on
 * Italian systems), so non-English output falls back to positional columns —
 * the column order is fixed regardless of language. Matching only English
 * headers is what made #462 report "everything is up to date" on non-English
 * machines: the table was never found.
 */
const WINGET_COLUMN_NAMES = ['name', 'id', 'version', 'available', 'source'] as const
type WingetColumnName = (typeof WINGET_COLUMN_NAMES)[number]

/**
 * Locate the table in `winget upgrade` / `winget list` output without relying
 * on the language of the column headers. The header is the line immediately
 * above the first dashes-only separator, and columns start wherever a header
 * token starts. Rows stop at the first trailing summary line ("11 upgrades
 * available.", "7 packages have version numbers that cannot be determined.",
 * or their translations) — every summary line starts with a count and, unlike
 * a real row, has no single-token Id in the Id column.
 */
export function locateWingetTable(stdout: string, minColumns: number): WingetTable | null {
  const lines = cleanOutput(stdout).split(/\r?\n/)

  let separatorIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (/^-{3,}\s*$/.test(lines[i]) && lines[i - 1].trim()) {
      separatorIdx = i
      break
    }
  }
  if (separatorIdx === -1) return null

  const header = lines[separatorIdx - 1]
  const columns: WingetColumn[] = []
  for (const m of header.matchAll(/\S+/g)) {
    columns.push({ label: m[0], start: displayWidth(header.slice(0, m.index ?? 0)) })
  }
  if (columns.length < minColumns) return null

  const idStart = columns[1].start
  const idEnd = columns[2].start
  const rows: string[] = []
  for (let i = separatorIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    if (/^\d+\s/.test(line)) {
      const idCell = sliceByDisplayColumns(line, idStart, idEnd).trim()
      if (!idCell || /\s/.test(idCell) || /\.\s*$/.test(line)) break
    }
    rows.push(line)
  }
  return { columns, rows }
}

/**
 * Resolve each logical column's [start, end) range. English headers are
 * matched by name; anything else uses the fixed winget column order.
 */
function resolveWingetColumns(
  columns: WingetColumn[]
): Partial<Record<WingetColumnName, [number, number]>> {
  const ranges: Partial<Record<WingetColumnName, [number, number]>> = {}
  const rangeAt = (i: number): [number, number] => [
    columns[i].start,
    i + 1 < columns.length ? columns[i + 1].start : Number.MAX_SAFE_INTEGER
  ]

  // Only trust names when every header is a known English one — German, for
  // instance, keeps "Name"/"ID"/"Version" but localises the rest.
  const englishHeader = columns.every((c) =>
    WINGET_COLUMN_NAMES.includes(c.label.toLowerCase() as WingetColumnName)
  )
  for (let i = 0; i < columns.length; i++) {
    const key = englishHeader ? columns[i].label.toLowerCase() : WINGET_COLUMN_NAMES[i]
    if (WINGET_COLUMN_NAMES.includes(key as WingetColumnName)) {
      ranges[key as WingetColumnName] = rangeAt(i)
    }
  }
  return ranges
}

function cell(line: string, range: [number, number] | undefined): string {
  if (!range) return ''
  return sliceByDisplayColumns(line, range[0], range[1]).trim()
}

/** winget prefixes versions with "> " or "< " when the installed version is uncertain. */
function stripVersionMarker(version: string): string {
  return version.replace(/^[<>]\s+/, '')
}

export function parseWingetUpgradeOutput(stdout: string): UpdatableApp[] {
  // Name  Id  Version  Available  Source — all five are always present
  const table = locateWingetTable(stdout, 5)
  if (!table) return []
  const cols = resolveWingetColumns(table.columns)
  if (!cols.name || !cols.id || !cols.version || !cols.available || !cols.source) return []

  const apps: UpdatableApp[] = []
  for (const line of table.rows) {
    const name = cell(line, cols.name)
    const id = cell(line, cols.id)
    const version = stripVersionMarker(cell(line, cols.version))
    const available = stripVersionMarker(cell(line, cols.available))
    const source = cell(line, cols.source)

    // Package ids never contain whitespace — a "cell" that does is wrapped
    // prose from a footer we failed to recognise, not a package.
    if (!id || /\s/.test(id) || !version || !available) continue
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
      selected: true
    })
  }
  return apps
}

export function parseWingetListOutput(stdout: string): UpToDateApp[] {
  // Name  Id  Version [Available] [Source] — the last two columns are only
  // present when at least one row has something to put in them.
  const table = locateWingetTable(stdout, 3)
  if (!table) return []
  const cols = resolveWingetColumns(table.columns)
  if (!cols.name || !cols.id || !cols.version) return []

  const apps: UpToDateApp[] = []
  for (const line of table.rows) {
    const name = cell(line, cols.name)
    const id = cell(line, cols.id)
    const version = stripVersionMarker(cell(line, cols.version))
    const source = cell(line, cols.source)

    if (!id || !version || version === 'Unknown') continue
    // Skip ARP entries (not real winget packages)
    if (id.startsWith('ARP\\')) continue

    apps.push({ id, name: stripTrailingVersion(name) || id, version, source: source || 'winget' })
  }
  return apps
}

/** Version component of an MSIX package folder (`Name_1.22.10_x64__hash`). */
function packageVersion(folder: string): string {
  return folder.split('_')[1] ?? ''
}

/** Compare dotted numeric versions; returns <0, 0 or >0 like a sort comparator. */
export function comparePackageVersions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (parseInt(pa[i] ?? '0', 10) || 0) - (parseInt(pb[i] ?? '0', 10) || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Places winget may live when it is not on PATH. Kudu runs elevated
 * (requireAdministrator); when UAC elevates under a different account than
 * the logged-in user, that account's PATH lacks the `WindowsApps` alias
 * directory and a bare `winget` fails with ENOENT even though the tool works
 * fine from the user's own terminal. The package directory under Program
 * Files is readable by administrators and holds the real executable.
 */
function wingetPathCandidates(): string[] {
  const candidates: string[] = []
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    candidates.push(join(localAppData, 'Microsoft', 'WindowsApps', 'winget.exe'))
  }
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const windowsApps = join(programFiles, 'WindowsApps')
  try {
    // Highest version first so a stale side-by-side package is not picked.
    // Compare version components numerically — lexicographic ordering would
    // rank 1.9 above 1.10.
    const packages = readdirSync(windowsApps)
      .filter((d) => /^Microsoft\.DesktopAppInstaller_.*_8wekyb3d8bbwe$/i.test(d))
      .sort((a, b) => comparePackageVersions(packageVersion(b), packageVersion(a)))
    for (const pkg of packages) {
      candidates.push(join(windowsApps, pkg, 'winget.exe'))
    }
  } catch {
    // Not admin, or no Store packages installed
  }
  return candidates.filter((p) => existsSync(p))
}

/** Resolved winget executable, cached once a probe succeeds. */
let wingetExe: string | null = null

/**
 * Find a working winget executable: PATH first, then the known install
 * locations. Returns null when none of them respond to `--version`.
 */
export async function resolveWinget(): Promise<string | null> {
  if (wingetExe) return wingetExe
  for (const candidate of ['winget', ...wingetPathCandidates()]) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 10_000, windowsHide: true })
      wingetExe = candidate
      return candidate
    } catch {
      // Try the next location
    }
  }
  return null
}

/** Exported for tests: forget the cached winget location. */
export function resetWingetCache(): void {
  wingetExe = null
}

/**
 * winget exit codes that mean "nothing to report" rather than "something went
 * wrong". Node surfaces the HRESULT as an unsigned 32-bit exit code.
 */
const WINGET_NOTHING_TO_DO_CODES = new Set([
  0x8a150014, // APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND
  0x8a15002b // APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE
])

function isWingetNothingToDo(code: unknown): boolean {
  return typeof code === 'number' && WINGET_NOTHING_TO_DO_CODES.has(code >>> 0)
}

/**
 * The scan alone is fast, but winget refreshes stale source indexes first and
 * the msstore source in particular can take well over a minute on a slow
 * connection. A timeout here used to be reported as "everything is up to
 * date" (#462); it is now surfaced as an error instead, but give winget
 * enough time that it rarely comes to that.
 */
const WINGET_CHECK_TIMEOUT = 3 * 60 * 1000

async function checkForUpdatesWinget(): Promise<UpdateCheckResult> {
  const winget = await resolveWinget()
  if (!winget) {
    return emptyResult(false, 'winget', 'winget was not found or did not start')
  }

  let stdout: string
  // Set when winget did not finish cleanly. Whatever rows it managed to print
  // are still returned, but flagged: a table cut off by a timeout or a source
  // failure is not a complete answer.
  let scanError: string | undefined
  try {
    const result = await execFileAsync(
      winget,
      ['upgrade', '--accept-source-agreements', '--disable-interactivity'],
      { timeout: WINGET_CHECK_TIMEOUT, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
    )
    stdout = result.stdout
  } catch (err: any) {
    // winget may exit with non-zero code even on success (e.g. 0x8A150014 = no updates)
    // but still produce valid output in stdout
    stdout = err?.stdout ?? ''
    if (!isWingetNothingToDo(err?.code)) {
      scanError = describeExecError(err, 'winget upgrade failed')
      if (locateWingetTable(stdout, 5) === null) return emptyResult(true, 'winget', scanError)
    }
  }

  const apps = parseWingetUpgradeOutput(stdout)

  // Also get the full list of winget-tracked apps to show "up to date" ones
  let upToDate: UpToDateApp[] = []
  try {
    let listStdout = ''
    try {
      const listResult = await execFileAsync(
        winget,
        ['list', '--source', 'winget', '--accept-source-agreements', '--disable-interactivity'],
        { timeout: WINGET_CHECK_TIMEOUT, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
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

  return buildResult('winget', apps, upToDate, scanError)
}

const WINGET_UPGRADE_ARGS = [
  '--accept-source-agreements',
  '--accept-package-agreements',
  '--disable-interactivity',
  '--silent',
  '--include-unknown'
]

const SUCCESS_PATTERNS = [
  'successfully installed',
  'successfully upgraded',
  'installer succeeded',
  'no available upgrade'
]

const FAILURE_PATTERNS = [
  'installer failed',
  'no package found',
  'no applicable update',
  'another version of this application',
  'installer aborted',
  'install technology is different'
]

const ELEVATION_HINTS = [
  'access is denied',
  'administrator',
  'elevation',
  'requires admin',
  'run as admin',
  '0x80070005' // E_ACCESSDENIED
]

/** Attempt a single winget upgrade and return {success, output} */
async function attemptWingetUpgrade(
  appId: string,
  extraArgs: string[] = []
): Promise<{ success: boolean; output: string }> {
  // Validate appId format to prevent argument injection (e.g. --source flags)
  if (!/^[\w][\w.\-]{0,200}$/.test(appId)) {
    return { success: false, output: 'Invalid app ID format' }
  }
  const winget = (await resolveWinget()) ?? 'winget'
  let upgradeStdout = ''
  try {
    const result = await execFileAsync(
      winget,
      ['upgrade', appId, ...WINGET_UPGRADE_ARGS, ...extraArgs],
      { timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
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
async function attemptElevatedUpgrade(
  appId: string
): Promise<{ success: boolean; output: string }> {
  // Validate appId format to prevent injection — winget IDs are alphanumeric with dots, dashes, underscores
  if (!/^[\w][\w.\-]{0,200}$/.test(appId)) {
    return { success: false, output: 'Invalid app ID format' }
  }

  try {
    const winget = (await resolveWinget()) ?? 'winget'
    const args = ['upgrade', appId, ...WINGET_UPGRADE_ARGS, '--force'].join(' ')
    // Escape single quotes for PowerShell single-quoted strings ('' is the escape for ')
    const safeArgs = args.replace(/'/g, "''")
    const safeExe = winget.replace(/'/g, "''")
    // Run winget elevated via Start-Process; -Wait blocks until done, -PassThru gives exit code
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        psUtf8(
          `$p = Start-Process '${safeExe}' -ArgumentList '${safeArgs}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`
        )
      ],
      { timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
    )
    // We can't reliably capture stdout from the elevated process, so verify
    // by checking if winget still lists this app as upgradeable
    const checkResult = await execFileAsync(
      winget,
      ['upgrade', '--accept-source-agreements', '--disable-interactivity', '--include-unknown'],
      { timeout: WINGET_CHECK_TIMEOUT, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
    )
    const stillNeedsUpgrade = checkResult.stdout.includes(appId)
    return {
      success: !stillNeedsUpgrade,
      output: stillNeedsUpgrade ? 'App still needs upgrade after elevated attempt' : stdout
    }
  } catch (err: any) {
    // UAC was likely denied by user
    return { success: false, output: err?.message || 'Elevated upgrade failed' }
  }
}

/** Run a single app through the winget upgrade pipeline: normal → elevated → force */
async function upgradeAppWinget(
  appId: string,
  alreadyAdmin: boolean
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
      return {
        success: false,
        error: 'Installer type changed — uninstall this app manually then install the new version'
      }
    }
  }

  // If still failed, retry once with --force (handles version mismatch issues)
  if (!result.success) {
    const retryResult = await attemptWingetUpgrade(appId, ['--force'])
    if (retryResult.success) result = retryResult
  }

  if (result.success) return { success: true }

  const lastLine = cleanOutput(result.output).trim().split('\n').pop() || 'Upgrade failed'
  return {
    success: false,
    error: lastLine.length > 200 ? lastLine.slice(0, 200) + '...' : lastLine
  }
}

// ─── Chocolatey (Windows) ──────────────────────────────────

/** Chocolatey package ID: alphanumeric, dots, hyphens, underscores */
const CHOCO_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/

async function isChocoAvailable(): Promise<boolean> {
  try {
    await execFileAsync('choco', ['--version'], {
      timeout: 10_000,
      windowsHide: true
    })
    return true
  } catch {
    return false
  }
}

/**
 * Parse `choco outdated --limit-output` output.
 * Format: packageId|currentVersion|availableVersion|pinned
 */
export function parseChocoOutdatedOutput(stdout: string): UpdatableApp[] {
  const apps: UpdatableApp[] = []
  for (const line of cleanOutput(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split('|')
    if (parts.length < 4) continue
    const [id, currentVersion, availableVersion, pinned] = parts
    if (!id || !currentVersion || !availableVersion) continue
    // Skip pinned packages
    if (pinned?.trim().toLowerCase() === 'true') continue
    // Skip if versions match (already up to date)
    if (currentVersion.trim() === availableVersion.trim()) continue
    apps.push({
      id: id.trim(),
      name: id.trim(),
      currentVersion: currentVersion.trim(),
      availableVersion: availableVersion.trim(),
      source: 'choco',
      severity: computeSeverity(currentVersion.trim(), availableVersion.trim()),
      selected: true
    })
  }
  return apps
}

/**
 * Parse `choco list --limit-output` output.
 * Format: packageId|version
 */
export function parseChocoListOutput(stdout: string): UpToDateApp[] {
  const apps: UpToDateApp[] = []
  for (const line of cleanOutput(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split('|')
    if (parts.length < 2) continue
    const [id, version] = parts
    if (!id || !version) continue
    apps.push({ id: id.trim(), name: id.trim(), version: version.trim(), source: 'choco' })
  }
  return apps
}

async function checkForUpdatesChoco(): Promise<UpdateCheckResult> {
  const available = await isChocoAvailable()
  if (!available) {
    return emptyResult(false, 'choco')
  }

  try {
    let stdout = ''
    try {
      const result = await execFileAsync('choco', ['outdated', '--limit-output'], {
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
      })
      stdout = result.stdout
    } catch (err: any) {
      if (err?.stdout) {
        stdout = err.stdout
      } else {
        return emptyResult(true, 'choco')
      }
    }

    const apps = parseChocoOutdatedOutput(stdout)

    // Get the full list of installed packages to show "up to date" ones
    let upToDate: UpToDateApp[] = []
    try {
      let listStdout = ''
      try {
        const listResult = await execFileAsync('choco', ['list', '--limit-output'], {
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true
        })
        listStdout = listResult.stdout
      } catch (err: any) {
        if (err?.stdout) listStdout = err.stdout
      }
      if (listStdout) {
        const allApps = parseChocoListOutput(listStdout)
        const outdatedIds = new Set(apps.map((a) => a.id))
        upToDate = allApps.filter((a) => !outdatedIds.has(a.id))
      }
    } catch {
      // Non-critical — just skip the up-to-date list
    }

    return buildResult('choco', apps, upToDate)
  } catch {
    return emptyResult(true, 'choco')
  }
}

const CHOCO_SUCCESS_PATTERNS = ['was successful', 'has been successfully', 'upgraded 1/']

const CHOCO_FAILURE_PATTERNS = [
  'was not successful',
  'not installed',
  'cannot find path',
  'unable to find'
]

const CHOCO_ELEVATION_HINTS = [
  'access to the path',
  'access is denied',
  'administrator',
  'run as admin',
  'elevated permissions'
]

/** Attempt a single choco upgrade and return {success, output} */
async function attemptChocoUpgrade(
  appId: string,
  extraArgs: string[] = []
): Promise<{ success: boolean; output: string }> {
  if (!CHOCO_ID_PATTERN.test(appId)) {
    return { success: false, output: 'Invalid package ID format' }
  }
  let upgradeStdout = ''
  try {
    // Note: no --limit-output here — verbose output is needed for success/failure pattern detection
    const result = await execFileAsync('choco', ['upgrade', appId, '-y', ...extraArgs], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    })
    upgradeStdout = result.stdout
  } catch (err: any) {
    if (err?.stdout) {
      upgradeStdout = err.stdout
    } else {
      return { success: false, output: err?.message || 'Unknown error' }
    }
  }

  const output = cleanOutput(upgradeStdout).toLowerCase()
  const wasSuccessful = CHOCO_SUCCESS_PATTERNS.some((p) => output.includes(p))
  const hasClearFailure = CHOCO_FAILURE_PATTERNS.some((p) => output.includes(p))

  if (wasSuccessful && !hasClearFailure) {
    return { success: true, output: upgradeStdout }
  }
  return { success: false, output: upgradeStdout }
}

/** Retry a failed choco upgrade with elevation using PowerShell Start-Process -Verb RunAs */
async function attemptElevatedChocoUpgrade(
  appId: string
): Promise<{ success: boolean; output: string }> {
  if (!CHOCO_ID_PATTERN.test(appId)) {
    return { success: false, output: 'Invalid package ID format' }
  }

  try {
    const args = ['upgrade', appId, '-y', '--force'].join(' ')
    const safeArgs = args.replace(/'/g, "''")
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        psUtf8(
          `$p = Start-Process choco -ArgumentList '${safeArgs}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`
        )
      ],
      { timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
    )
    // Verify by checking if choco still lists this app as outdated
    const checkResult = await execFileAsync('choco', ['outdated', '--limit-output'], {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    })
    const stillNeedsUpgrade = checkResult.stdout
      .split(/\r?\n/)
      .some((line) => line.startsWith(appId + '|'))
    return {
      success: !stillNeedsUpgrade,
      output: stillNeedsUpgrade
        ? 'Package still needs upgrade after elevated attempt'
        : 'Elevated upgrade succeeded'
    }
  } catch (err: any) {
    return { success: false, output: err?.message || 'Elevated upgrade failed' }
  }
}

/** Run a single app through the choco upgrade pipeline: normal → elevated → force */
async function upgradeAppChoco(
  appId: string,
  alreadyAdmin: boolean
): Promise<{ success: boolean; error?: string }> {
  // First attempt: normal upgrade
  let result = await attemptChocoUpgrade(appId)

  // If failed and not already admin, check for elevation hints before prompting
  if (!result.success && !alreadyAdmin) {
    const lowerOutput = cleanOutput(result.output).toLowerCase()
    const looksLikeElevationIssue =
      CHOCO_ELEVATION_HINTS.some((h) => lowerOutput.includes(h)) ||
      CHOCO_FAILURE_PATTERNS.some((p) => lowerOutput.includes(p))

    if (looksLikeElevationIssue) {
      result = await attemptElevatedChocoUpgrade(appId)
    }
  }

  // If still failed, retry once with --force (handles version mismatch issues)
  if (!result.success) {
    const retryResult = await attemptChocoUpgrade(appId, ['--force'])
    if (retryResult.success) result = retryResult
  }

  if (result.success) return { success: true }

  const lastLine = cleanOutput(result.output).trim().split('\n').pop() || 'Upgrade failed'
  return {
    success: false,
    error: lastLine.length > 200 ? lastLine.slice(0, 200) + '...' : lastLine
  }
}

// ─── Shim runner (scoop / npm) ─────────────────────────────

/**
 * Run a `.cmd` shim tool (scoop, npm) via cmd.exe.
 *
 * These tools ship as `.cmd`/`.ps1` shims, not native `.exe`, so `execFile`
 * can't resolve a bare name. We route through `cmd.exe` rather than
 * `powershell.exe` on purpose: PowerShell command resolution can pick the
 * `.ps1` shim (npm.ps1 / scoop.ps1), which fails under the default
 * Restricted / AllSigned execution policy before the tool ever runs. cmd.exe
 * resolves the `.cmd` shim via PATHEXT (which excludes `.ps1`), and those
 * shims invoke PowerShell with their own bypass, so they work regardless of
 * the machine's execution policy.
 *
 * `chcp 65001` forces UTF-8 output. Callers MUST validate any dynamic argument
 * (app id) against the tool's id pattern first; shim ids contain no cmd.exe
 * metacharacters, so building the command line is safe.
 */
async function runShim(tool: 'scoop' | 'npm', args: string[], timeout = 60_000): Promise<string> {
  const cmdLine = `chcp 65001>nul && ${tool} ${args.join(' ')}`
  const { stdout } = await execFileAsync('cmd.exe', ['/d', '/v:off', '/s', '/c', cmdLine], {
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: true
  })
  return stdout
}

// ─── Scoop (Windows) ────────────────────────────────────────

/** Scoop app name: lowercase alphanumeric, hyphens, dots, underscores, plus */
const SCOOP_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,200}$/

const runScoop = (args: string[], timeout = 60_000): Promise<string> =>
  runShim('scoop', args, timeout)

async function isScoopAvailable(): Promise<boolean> {
  try {
    const out = await runScoop(['--version'], 15_000)
    // scoop --version prints its git revision; any non-empty output means it ran
    return out.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Parse `scoop status` table output.
 * Columns: Name | Installed Version | Latest Version | Missing Dependencies | Info
 * Version strings never contain spaces, so the "Latest Version" cell is read as
 * its first whitespace-delimited token — robust against trailing columns.
 */
export function parseScoopStatus(stdout: string): UpdatableApp[] {
  const lines = cleanOutput(stdout).split(/\r?\n/)

  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/Installed Version/i.test(lines[i]) && /Latest Version/i.test(lines[i])) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) return []

  const header = lines[headerIdx]
  const installedStart = header.indexOf('Installed Version')
  const latestStart = header.indexOf('Latest Version')
  if (installedStart < 0 || latestStart < 0) return []

  let start = headerIdx + 1
  // Skip the dashes separator row that Format-Table emits under the header
  if (start < lines.length && /^[-\s]+$/.test(lines[start])) start++

  const apps: UpdatableApp[] = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    const name = line.substring(0, installedStart).trim()
    const currentVersion = line.substring(installedStart, latestStart).trim()
    const availableVersion = line.substring(latestStart).trim().split(/\s+/)[0] ?? ''

    if (!name || !availableVersion) continue
    if (currentVersion === availableVersion) continue

    apps.push({
      id: name,
      name,
      currentVersion,
      availableVersion,
      source: 'scoop',
      severity: computeSeverity(currentVersion, availableVersion),
      selected: true
    })
  }
  return apps
}

/**
 * Parse `scoop export` JSON into the installed list.
 * Modern scoop emits `{ apps: [{ Name, Version, Source }] }`; some builds emit a
 * bare array. Both shapes are handled; anything else yields an empty list.
 */
export function parseScoopExport(stdout: string): UpToDateApp[] {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return []
  }

  const entries: any[] = Array.isArray(data)
    ? data
    : Array.isArray((data as any)?.apps)
      ? (data as any).apps
      : []

  const apps: UpToDateApp[] = []
  for (const entry of entries) {
    const name = entry?.Name ?? entry?.name
    const version = entry?.Version ?? entry?.version ?? ''
    if (!name) continue
    apps.push({ id: name, name, version, source: 'scoop' })
  }
  return apps
}

async function checkForUpdatesScoop(): Promise<UpdateCheckResult> {
  if (!(await isScoopAvailable())) return emptyResult(false, 'scoop')

  try {
    // Refresh bucket manifests first. `scoop status` compares installed
    // versions against the *local* bucket checkout, so a stale checkout reports
    // apps as up to date even when newer versions exist. `scoop update` with no
    // app argument only updates Scoop and its buckets — it never upgrades an
    // installed app — so it's safe to run during a read-only check. Best-effort:
    // if the refresh fails (offline, etc.) we still read whatever status we can.
    try {
      await runScoop(['update'], 120_000)
    } catch {
      // Bucket refresh failed — fall through and read status against local manifests.
    }

    // `scoop status` compares installed versions against the refreshed manifests
    let statusStdout = ''
    try {
      statusStdout = await runScoop(['status'], 120_000)
    } catch (err: any) {
      if (err?.stdout) statusStdout = err.stdout
      else return emptyResult(true, 'scoop')
    }

    const apps = parseScoopStatus(statusStdout)

    let upToDate: UpToDateApp[] = []
    try {
      const exportStdout = await runScoop(['export'], 60_000)
      const allApps = parseScoopExport(exportStdout)
      const outdatedIds = new Set(apps.map((a) => a.id))
      upToDate = allApps.filter((a) => !outdatedIds.has(a.id))
    } catch {
      // Non-critical — just skip the up-to-date list
    }

    return buildResult('scoop', apps, upToDate)
  } catch {
    return emptyResult(true, 'scoop')
  }
}

const truncateError = (msg: string): string => (msg.length > 200 ? msg.slice(0, 200) + '...' : msg)

/**
 * Decide whether a `scoop update` succeeded from its output and exit status.
 * Exported for tests. `nonZeroExit` is true when scoop exited nonzero (stdout
 * may still carry progress). Ambiguous output is only assumed successful on a
 * clean exit — a nonzero exit with no explicit success marker is a failure, so
 * a broken update can't be masked by partial progress output. Exported for tests.
 */
export function classifyScoopUpdate(
  output: string,
  nonZeroExit: boolean,
  stderrMsg = ''
): { success: boolean; error?: string } {
  const cleaned = cleanOutput(output)
  const lower = cleaned.toLowerCase()
  // scoop prints "'app' was updated" / "was installed" on success; "is already
  // installed" means it's up to date (also a success from the user's view)
  if (/(was updated|was installed|is already installed|latest version)/.test(lower)) {
    return { success: true }
  }
  if (/error|failed|couldn't|could not/.test(lower)) {
    return {
      success: false,
      error: truncateError(cleaned.trim().split('\n').pop() || 'Update failed')
    }
  }
  // Nonzero exit with no explicit success marker → treat as a failure rather
  // than letting ambiguous progress output mask it. stderr is the best signal.
  if (nonZeroExit) {
    return {
      success: false,
      error: truncateError(stderrMsg || cleaned.trim().split('\n').pop() || 'Update failed')
    }
  }
  // Clean exit with ambiguous output — assume success
  return { success: true }
}

/** Attempt a single `scoop update <app>` */
async function upgradeAppScoop(appId: string): Promise<{ success: boolean; error?: string }> {
  if (!SCOOP_ID_PATTERN.test(appId)) {
    return { success: false, error: 'Invalid app name format' }
  }
  let output = ''
  let nonZeroExit = false
  let stderrMsg = ''
  try {
    output = await runScoop(['update', appId], 10 * 60 * 1000)
  } catch (err: any) {
    // A nonzero exit still often carries useful progress on stdout; keep it,
    // but remember the failure and preserve stderr for diagnostics.
    nonZeroExit = true
    stderrMsg = err?.stderr ? cleanOutput(err.stderr).trim() : ''
    if (err?.stdout) output = err.stdout
    else return { success: false, error: stderrMsg || err?.message || 'Unknown error' }
  }

  return classifyScoopUpdate(output, nonZeroExit, stderrMsg)
}

// ─── npm global (Windows) ───────────────────────────────────

/** npm package name incl. scoped (@scope/name); npm enforces the rest */
const NPM_ID_PATTERN = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]{0,200}$/i

const runNpm = (args: string[], timeout = 60_000): Promise<string> => runShim('npm', args, timeout)

async function isNpmAvailable(): Promise<boolean> {
  try {
    const out = await runNpm(['--version'], 15_000)
    return /\d+\.\d+/.test(out)
  } catch {
    return false
  }
}

/**
 * Parse `npm outdated -g --json` output.
 * Shape: `{ "pkg": { "current": "1.0.0", "wanted": "1.2.0", "latest": "2.0.0" } }`
 */
export function parseNpmOutdated(stdout: string): UpdatableApp[] {
  let data: Record<string, { current?: string; wanted?: string; latest?: string }>
  try {
    data = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!data || typeof data !== 'object') return []

  const apps: UpdatableApp[] = []
  for (const [name, info] of Object.entries(data)) {
    const current = info?.current ?? ''
    const available = info?.latest ?? info?.wanted ?? ''
    if (!available) continue
    if (current && current === available) continue
    apps.push({
      id: name,
      name,
      currentVersion: current || '—',
      availableVersion: available,
      source: 'npm',
      severity: computeSeverity(current, available),
      selected: true
    })
  }
  return apps
}

/**
 * Parse `npm ls -g --depth=0 --json` output into the installed list.
 * Shape: `{ "dependencies": { "pkg": { "version": "1.0.0" } } }`
 */
export function parseNpmListGlobal(stdout: string): UpToDateApp[] {
  let data: { dependencies?: Record<string, { version?: string }> }
  try {
    data = JSON.parse(stdout)
  } catch {
    return []
  }
  const deps = data?.dependencies
  if (!deps || typeof deps !== 'object') return []

  const apps: UpToDateApp[] = []
  for (const [name, info] of Object.entries(deps)) {
    apps.push({ id: name, name, version: info?.version ?? '', source: 'npm' })
  }
  return apps
}

async function checkForUpdatesNpm(): Promise<UpdateCheckResult> {
  if (!(await isNpmAvailable())) return emptyResult(false, 'npm')

  try {
    // `npm outdated` exits non-zero when packages are outdated, but still
    // emits JSON on stdout — recover it from the error like the other managers.
    let outdatedStdout = ''
    try {
      outdatedStdout = await runNpm(['outdated', '-g', '--json'], 90_000)
    } catch (err: any) {
      outdatedStdout = err?.stdout ?? ''
    }

    const apps = parseNpmOutdated(outdatedStdout)

    let upToDate: UpToDateApp[] = []
    try {
      let listStdout = ''
      try {
        listStdout = await runNpm(['ls', '-g', '--depth=0', '--json'], 60_000)
      } catch (err: any) {
        // npm ls exits non-zero on peer-dep warnings but still prints JSON
        listStdout = err?.stdout ?? ''
      }
      const allApps = parseNpmListGlobal(listStdout)
      const outdatedIds = new Set(apps.map((a) => a.id))
      upToDate = allApps.filter((a) => !outdatedIds.has(a.id))
    } catch {
      // Non-critical — just skip the up-to-date list
    }

    return buildResult('npm', apps, upToDate)
  } catch {
    return emptyResult(true, 'npm')
  }
}

/** Attempt a single `npm install -g <pkg>@latest` */
async function upgradeAppNpm(appId: string): Promise<{ success: boolean; error?: string }> {
  if (!NPM_ID_PATTERN.test(appId)) {
    return { success: false, error: 'Invalid package name format' }
  }
  try {
    await runNpm(['install', '-g', `${appId}@latest`], 10 * 60 * 1000)
    return { success: true }
  } catch (err: any) {
    const output = cleanOutput(err?.stderr || err?.stdout || err?.message || 'Unknown error')
    const lastLine = output.trim().split('\n').pop() || 'Update failed'
    return {
      success: false,
      error: lastLine.length > 200 ? lastLine.slice(0, 200) + '...' : lastLine
    }
  }
}

// ─── Windows: aggregation dispatcher ───────────────────────

const WINDOWS_MANAGERS: WindowsPackageManager[] = ['winget', 'choco', 'scoop', 'npm']

const WINDOWS_CHECKERS: Record<WindowsPackageManager, () => Promise<UpdateCheckResult>> = {
  winget: checkForUpdatesWinget,
  choco: checkForUpdatesChoco,
  scoop: checkForUpdatesScoop,
  npm: checkForUpdatesNpm
}

/** Managers the user has enabled for aggregation (all supported when unset). */
function enabledWindowsManagers(): WindowsPackageManager[] {
  const configured = getSettings().windowsPackageManagers
  if (!configured || configured.length === 0) return WINDOWS_MANAGERS
  return WINDOWS_MANAGERS.filter((m) => configured.includes(m))
}

/**
 * Scan every enabled Windows manager concurrently and merge the results into a
 * single list. Each app keeps its `source`, so it can be routed back to its
 * owning manager on update (UniGetUI-style aggregation).
 */
async function checkForUpdatesWindows(): Promise<UpdateCheckResult> {
  const enabled = enabledWindowsManagers()
  const results = await Promise.all(
    enabled.map((m) =>
      WINDOWS_CHECKERS[m]().catch((err) =>
        emptyResult(false, m, describeExecError(err, `${m} check failed`))
      )
    )
  )

  const apps = results.flatMap((r) => r.apps)
  const upToDate = results.flatMap((r) => r.upToDate)
  const managers: PackageManagerStatus[] = results.map((r, i) => {
    const error = r.managers[0]?.error
    return {
      name: enabled[i],
      available: r.packageManagerAvailable,
      outdatedCount: r.apps.length,
      ...(error ? { error } : {})
    }
  })

  return {
    apps,
    upToDate,
    totalCount: apps.length,
    majorCount: apps.filter((a) => a.severity === 'major').length,
    minorCount: apps.filter((a) => a.severity === 'minor').length,
    patchCount: apps.filter((a) => a.severity === 'patch').length,
    packageManagerAvailable: managers.some((m) => m.available),
    packageManagerName: managers.find((m) => m.available)?.name ?? null,
    managers
  }
}

/** Upgrade a single package with the pipeline appropriate to its manager. */
function upgradeWindowsApp(
  source: WindowsPackageManager,
  appId: string,
  alreadyAdmin: boolean
): Promise<{ success: boolean; error?: string }> {
  switch (source) {
    case 'winget':
      return upgradeAppWinget(appId, alreadyAdmin)
    case 'choco':
      return upgradeAppChoco(appId, alreadyAdmin)
    case 'scoop':
      return upgradeAppScoop(appId)
    case 'npm':
      return upgradeAppNpm(appId)
  }
}

/**
 * Update packages spanning multiple managers. Items are grouped by their
 * `source`, then each manager's packages are upgraded in turn while a single
 * progress stream is reported across the whole batch.
 */
/**
 * Group Windows update items by their routing manager, preserving a stable
 * manager order. Each entry keeps its *original* source so failures can be
 * reported under the source the renderer keyed the row by: a winget-owned
 * package from a non-manager source (e.g. `msstore`) routes through winget but
 * must be reported as `msstore`, or the renderer's `source␟id` lookup won't
 * match it. Exported for tests.
 */
export function groupWindowsUpdateItems(
  items: UpdateRequestItem[]
): Map<WindowsPackageManager, Array<{ id: string; source: string }>> {
  const groups = new Map<WindowsPackageManager, Array<{ id: string; source: string }>>()
  for (const item of items) {
    const manager = WINDOWS_MANAGERS.includes(item.source as WindowsPackageManager)
      ? (item.source as WindowsPackageManager)
      : 'winget' // default routing for un-tagged / winget-owned sources (msstore, etc.)
    const list = groups.get(manager) ?? []
    list.push({ id: item.id, source: item.source || manager })
    groups.set(manager, list)
  }
  return groups
}

async function runUpdatesWindows(
  items: UpdateRequestItem[],
  onProgress: (progress: UpdateProgress) => void
): Promise<UpdateResult> {
  const alreadyAdmin = isAdmin()
  const total = items.length
  let completed = 0
  let succeeded = 0
  let failed = 0
  const errors: UpdateResult['errors'] = []

  const groups = groupWindowsUpdateItems(items)

  for (const manager of WINDOWS_MANAGERS) {
    const entries = groups.get(manager)
    if (!entries?.length) continue

    for (const { id: appId, source: origSource } of entries) {
      completed++
      onProgress({
        phase: 'updating',
        current: completed,
        total,
        currentApp: appId,
        percent: Math.round(((completed - 1) / total) * 100),
        status: 'in-progress'
      })

      const result = await upgradeWindowsApp(manager, appId, alreadyAdmin)

      if (result.success) {
        succeeded++
        onProgress({
          phase: 'updating',
          current: completed,
          total,
          currentApp: appId,
          percent: Math.round((completed / total) * 100),
          status: 'done'
        })
      } else {
        failed++
        errors.push({
          appId,
          name: appId,
          reason: result.error || 'Upgrade failed',
          source: origSource
        })
        onProgress({
          phase: 'updating',
          current: completed,
          total,
          currentApp: appId,
          percent: Math.round((completed / total) * 100),
          status: 'failed'
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

/**
 * Brew install locations to probe, in priority order. macOS GUI apps inherit
 * PATH from launchd (typically just /usr/bin:/bin:/usr/sbin:/sbin) and never
 * read the user's shell rc files, so a bare `brew` lookup fails even when
 * brew is installed and on the user's interactive shell PATH. We probe the
 * standard install locations first, then fall back to a PATH lookup so
 * non-standard installs still work when the user launched Kudu from a shell.
 */
export const BREW_PATH_CANDIDATES = [
  '/opt/homebrew/bin/brew', // Apple Silicon default
  '/usr/local/bin/brew', // Intel default
  'brew' // PATH lookup fallback
]

let cachedBrewPath: string | null | undefined

/** Resolve the path to the brew executable, or null if brew is not installed. */
async function resolveBrewPath(): Promise<string | null> {
  if (cachedBrewPath !== undefined) return cachedBrewPath
  for (const candidate of BREW_PATH_CANDIDATES) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 10_000 })
      cachedBrewPath = candidate
      return candidate
    } catch {
      /* try next candidate */
    }
  }
  cachedBrewPath = null
  return null
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
      selected: true
    })
  }

  for (const c of data.casks ?? []) {
    const id = c.token || c.name
    const currentVersion = typeof c.installed_versions === 'string' ? c.installed_versions : ''
    apps.push({
      id,
      name: id,
      currentVersion,
      availableVersion: c.current_version,
      source: 'brew',
      severity: computeSeverity(currentVersion, c.current_version),
      selected: true
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
  const brewPath = await resolveBrewPath()
  if (!brewPath) {
    return emptyResult(false, 'brew')
  }

  try {
    // Get outdated packages as JSON
    let outdatedStdout = ''
    try {
      const result = await execFileAsync(brewPath, ['outdated', '--json=v2'], {
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024
      })
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
        const infoResult = await execFileAsync(brewPath, ['info', '--json=v2', '--installed'], {
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024
        })
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

    return buildResult('brew', apps, upToDate)
  } catch {
    return emptyResult(true, 'brew')
  }
}

/** Attempt a single brew upgrade */
async function attemptBrewUpgrade(name: string): Promise<{ success: boolean; error?: string }> {
  if (!BREW_ID_PATTERN.test(name) || name.length > 200) {
    return { success: false, error: 'Invalid package name format' }
  }

  const brewPath = await resolveBrewPath()
  if (!brewPath) {
    return { success: false, error: 'brew not found' }
  }

  try {
    await execFileAsync(brewPath, ['upgrade', name], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024
    })
    return { success: true }
  } catch (err: any) {
    const output = cleanOutput(err?.stderr || err?.stdout || err?.message || 'Unknown error')
    const lastLine = output.trim().split('\n').pop() || 'Upgrade failed'
    return {
      success: false,
      error: lastLine.length > 200 ? lastLine.slice(0, 200) + '...' : lastLine
    }
  }
}

async function runUpdatesBrew(
  appIds: string[],
  onProgress: (progress: UpdateProgress) => void
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
      status: 'in-progress'
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
        status: 'done'
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
        status: 'failed'
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
    { name: 'pacman', paths: ['/usr/bin/pacman', '/bin/pacman'] }
  ]
  for (const { name, paths } of candidates) {
    for (const p of paths) {
      try {
        await execFileAsync(p, ['--version'], { timeout: 3_000 })
        return name
      } catch {
        /* not found */
      }
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
      selected: true
    })
  }
  return apps
}

/** Parse `dpkg-query -W` output into up-to-date list */
export function parseDpkgInstalled(stdout: string): UpToDateApp[] {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, version] = line.split('\t')
      return { id: name, name, version: version ?? '', source: 'apt' }
    })
}

async function checkForUpdatesApt(): Promise<UpdateCheckResult> {
  try {
    // Refresh package cache (may fail without root — that's OK, uses stale cache)
    try {
      await execFileAsync('/usr/bin/apt-get', ['update', '-qq'], { timeout: 60_000 })
    } catch {
      /* non-root: use existing cache */
    }

    let upgradableStdout = ''
    try {
      const result = await execFileAsync('/usr/bin/apt', ['list', '--upgradable'], {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024
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
      const { stdout: dpkgOut } = await execFileAsync(
        '/usr/bin/dpkg-query',
        ['-W', '-f', '${Package}\t${Version}\n'],
        { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
      )
      const allInstalled = parseDpkgInstalled(dpkgOut)
      const outdatedIds = new Set(apps.map((a) => a.id))
      upToDate = allInstalled.filter((a) => !outdatedIds.has(a.id))
    } catch {
      /* non-critical */
    }

    return buildResult('apt', apps, upToDate)
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
      selected: true
    })
  }
  return apps
}

async function checkForUpdatesDnf(): Promise<UpdateCheckResult> {
  try {
    // dnf check-update exits 100 when updates are available
    let checkStdout = ''
    try {
      const result = await execFileAsync('/usr/bin/dnf', ['check-update', '-q'], {
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024
      })
      checkStdout = result.stdout
    } catch (err: any) {
      checkStdout = err?.stdout ?? ''
    }

    const apps = parseDnfCheckUpdate(checkStdout)

    // Get installed versions to fill in currentVersion and build up-to-date list
    const upToDate: UpToDateApp[] = []
    try {
      const { stdout: rpmOut } = await execFileAsync(
        '/usr/bin/rpm',
        ['-qa', '--queryformat', '%{NAME}\t%{VERSION}-%{RELEASE}\n'],
        { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
      )

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
    } catch {
      /* non-critical */
    }

    return buildResult('dnf', apps, upToDate)
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
      selected: true
    })
  }
  return apps
}

async function checkForUpdatesPacman(): Promise<UpdateCheckResult> {
  try {
    // Sync database first
    try {
      await execFileAsync('/usr/bin/pacman', ['-Sy'], { timeout: 60_000 })
    } catch {
      /* may need root — use stale db */
    }

    let quStdout = ''
    try {
      const result = await execFileAsync('/usr/bin/pacman', ['-Qu'], {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024
      })
      quStdout = result.stdout
    } catch (err: any) {
      // pacman -Qu exits 1 when no updates available
      if (err?.stdout) quStdout = err.stdout
    }

    const apps = parsePacmanQu(quStdout)

    // Get all installed for up-to-date list
    const upToDate: UpToDateApp[] = []
    try {
      const { stdout: qOut } = await execFileAsync('/usr/bin/pacman', ['-Q'], {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024
      })
      const outdatedIds = new Set(apps.map((a) => a.id))
      for (const line of qOut.trim().split('\n')) {
        if (!line.trim()) continue
        const [name, version] = line.split(' ')
        if (name && !outdatedIds.has(name)) {
          upToDate.push({ id: name, name, version: version ?? '', source: 'pacman' })
        }
      }
    } catch {
      /* non-critical */
    }

    return buildResult('pacman', apps, upToDate)
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
  appId: string
): Promise<{ success: boolean; error?: string }> {
  if (!LINUX_PKG_PATTERN.test(appId)) {
    return { success: false, error: 'Invalid package name format' }
  }

  try {
    if (pm === 'apt') {
      await execFileAsync('/usr/bin/apt-get', ['install', '-y', '-qq', appId], {
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024
      })
    } else if (pm === 'dnf') {
      await execFileAsync('/usr/bin/dnf', ['upgrade', '-y', '-q', appId], {
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024
      })
    } else {
      await execFileAsync('/usr/bin/pacman', ['-S', '--noconfirm', appId], {
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024
      })
    }
    return { success: true }
  } catch (err: any) {
    const output = cleanOutput(err?.stderr || err?.stdout || err?.message || 'Unknown error')
    const lastLine = output.trim().split('\n').pop() || 'Upgrade failed'
    return {
      success: false,
      error: lastLine.length > 200 ? lastLine.slice(0, 200) + '...' : lastLine
    }
  }
}

async function runUpdatesLinux(
  appIds: string[],
  onProgress: (progress: UpdateProgress) => void
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
      status: 'in-progress'
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
        status: 'done'
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
        status: 'failed'
      })
    }
  }

  return { succeeded, failed, errors }
}

// ─── Platform-dispatched exports ────────────────────────────

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (process.platform === 'darwin') return checkForUpdatesBrew()
  if (process.platform === 'win32') return checkForUpdatesWindows()
  if (process.platform === 'linux') return checkForUpdatesLinux()
  return emptyResult(false, null)
}

export async function runUpdates(
  items: UpdateRequestItem[],
  onProgress: (progress: UpdateProgress) => void
): Promise<UpdateResult> {
  if (process.platform === 'win32') return runUpdatesWindows(items, onProgress)
  // Single-manager platforms ignore per-item source — every id belongs to the
  // one active manager.
  const appIds = items.map((i) => i.id)
  if (process.platform === 'darwin') return runUpdatesBrew(appIds, onProgress)
  if (process.platform === 'linux') return runUpdatesLinux(appIds, onProgress)
  return { succeeded: 0, failed: 0, errors: [] }
}

/** Winget package id: alphanumeric plus dot/dash/underscore */
const WINGET_ID_PATTERN = /^[\w][\w.\-]{0,200}$/

/** Validate an app ID for the current platform's package manager */
export function isValidAppId(id: string): boolean {
  if (process.platform === 'darwin') return BREW_ID_PATTERN.test(id) && id.length <= 200
  if (process.platform === 'linux') return LINUX_PKG_PATTERN.test(id)
  return WINGET_ID_PATTERN.test(id)
}

/**
 * Validate an app ID against the pattern of the manager that owns it. Needed
 * for aggregation: npm scoped names (`@scope/pkg`) and Scoop names containing
 * `+` are valid for their manager but rejected by the winget/legacy pattern.
 */
export function isValidAppIdForSource(id: string, source: string): boolean {
  switch (source) {
    case 'winget':
      return WINGET_ID_PATTERN.test(id)
    case 'choco':
      return CHOCO_ID_PATTERN.test(id)
    case 'scoop':
      return SCOOP_ID_PATTERN.test(id)
    case 'npm':
      return NPM_ID_PATTERN.test(id)
    case 'brew':
      return BREW_ID_PATTERN.test(id) && id.length <= 200
    case 'apt':
    case 'dnf':
    case 'pacman':
      return LINUX_PKG_PATTERN.test(id)
    default:
      return isValidAppId(id)
  }
}
