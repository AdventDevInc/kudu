import { app } from 'electron'
import { existsSync } from 'fs'
import { readdir } from 'fs/promises'
import { join } from 'path'
import { scanDirectory, scanFile, scanMultipleDirectories, scanDirectoriesAsItems, resolveChildSubdirs, cleanItems, getDirectorySize } from './services/file-utils'
import { cacheItems } from './services/scan-cache'
import { CleanerType } from '../shared/enums'
import type { ScanResult, CleanResult } from '../shared/types'
import { getPlatform } from './platform'
import { randomUUID } from 'crypto'
import { psUtf8 } from './services/exec-utf8'

// ─── Types ──────────────────────────────────────────────────

type Verbosity = 'quiet' | 'normal' | 'verbose'

export interface CliContext {
  json: boolean
  verbosity: Verbosity
}

export const ExitCode = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  INVALID_ARGS: 2,
  PERMISSION_DENIED: 3,
  PARTIAL_SUCCESS: 4,
  NOTHING_FOUND: 5,
  UNKNOWN_COMMAND: 6,
  SCAN_THREATS: 7,
} as const

export interface ParsedCliArgs {
  command: string | undefined
  commandArgs: string[]
  ctx: CliContext
  help: boolean
  version: boolean
  hasLegacyFlags: boolean
  hasCleanFlag: boolean
}

// ─── Output helpers ──────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(msg + '\n')
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`
}

function cliLog(ctx: CliContext, msg: string): void {
  if (ctx.verbosity === 'quiet') return
  process.stdout.write(msg + '\n')
}

function cliVerbose(ctx: CliContext, msg: string): void {
  if (ctx.verbosity !== 'verbose') return
  process.stdout.write(`  [verbose] ${msg}\n`)
}

function cliOut(ctx: CliContext, data: unknown): void {
  if (ctx.json) {
    log(JSON.stringify(data, null, 2))
  } else if (ctx.verbosity === 'quiet') {
    return
  } else if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'string') log(`  ${item}`)
      else log(`  ${JSON.stringify(item)}`)
    }
  } else if (typeof data === 'object' && data !== null) {
    for (const [k, v] of Object.entries(data)) {
      log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    }
  } else {
    log(String(data))
  }
}

function cliUsage(ctx: CliContext, usage: string): void {
  if (ctx.json) {
    log(JSON.stringify({ error: 'invalid_usage', usage }))
  } else {
    // Always show usage errors, even in quiet mode
    log(`Usage: ${usage}`)
  }
}

function cliNotFound(ctx: CliContext, type: string, name: string): void {
  if (ctx.json) {
    log(JSON.stringify({ error: 'not_found', type, name }))
  } else {
    // Always show not-found errors, even in quiet mode
    log(`${type} not found: ${name}`)
  }
}

/** Whether to show interactive progress (carriage-return overwrites) */
function showProgress(ctx: CliContext): boolean {
  return ctx.verbosity !== 'quiet' && !ctx.json
}

// ─── Argument parsing ───────────────────────────────────────

const GLOBAL_FLAGS = new Set(['--json', '--verbose', '--quiet', '-q', '--help', '-h', '--version', '-v'])

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const cliIndex = argv.indexOf('--cli')
  const cliArgs = argv.slice(cliIndex + 1)

  const json = cliArgs.includes('--json')
  const verbose = cliArgs.includes('--verbose')
  const quiet = cliArgs.includes('--quiet') || cliArgs.includes('-q')
  const help = cliArgs.includes('--help') || cliArgs.includes('-h')
  const version = cliArgs.includes('--version') || cliArgs.includes('-v')

  const verbosity: Verbosity = verbose ? 'verbose' : quiet ? 'quiet' : 'normal'
  const ctx: CliContext = { json, verbosity }

  const command = cliArgs.find(a => !a.startsWith('--') && !a.startsWith('-'))
  const commandArgs = cliArgs.filter(a => a !== command && !GLOBAL_FLAGS.has(a))

  const legacyCats = ['system', 'browser', 'app', 'gaming', 'recycle-bin']
  const hasLegacyFlags = legacyCats.some(c => cliArgs.includes(`--${c}`)) || cliArgs.includes('--all')
  const hasCleanFlag = cliArgs.includes('--clean')

  return { command, commandArgs, ctx, help, version, hasLegacyFlags, hasCleanFlag }
}

// ─── Legacy scan implementations (file-based cleaners) ───────

async function scanSystem(): Promise<ScanResult[]> {
  const results: ScanResult[] = []
  const category = CleanerType.System
  const platform = getPlatform()
  const targets = platform.paths.systemCleanTargets()
  const protectedEventLogs = platform.paths.protectedEventLogs()
  const eventLogsTarget = targets.find((t) => t.subcategory === 'Event Log Archives')

  for (const target of targets) {
    try {
      let result
      if (target.childSubdir) {
        const childPaths = await resolveChildSubdirs([target.path], target.childSubdir)
        result = await scanMultipleDirectories(childPaths, category, target.subcategory)
      } else {
        result = await scanDirectory(target.path, category, target.subcategory)
      }
      if (eventLogsTarget && target.path === eventLogsTarget.path) {
        result.items = result.items.filter((item) => {
          const fileName = item.path.split(/[\\/]/).pop()?.toLowerCase() || ''
          return !protectedEventLogs.some((p) => fileName === p)
        })
        result.totalSize = result.items.reduce((s, item) => s + item.size, 0)
        result.itemCount = result.items.length
      }
      if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
    } catch { /* skip */ }
  }
  for (const target of platform.paths.singleFileCleanTargets()) {
    try {
      const dumpResult = await scanFile(target.path, category, target.subcategory)
      if (dumpResult.items.length > 0) { cacheItems(dumpResult.items); results.push(dumpResult) }
    } catch { /* skip */ }
  }
  return results
}

async function scanBrowserCli(): Promise<ScanResult[]> {
  const results: ScanResult[] = []
  const category = CleanerType.Browser
  const browserPaths = getPlatform().paths.browserPaths()
  const chromiumBrowsers = [
    { label: 'Chrome', ...browserPaths.chrome, hasProfiles: true },
    { label: 'Edge', ...browserPaths.edge, hasProfiles: true },
    { label: 'Brave', ...browserPaths.brave, hasProfiles: true },
    { label: 'Vivaldi', ...browserPaths.vivaldi, hasProfiles: true },
    { label: 'Opera', ...browserPaths.opera, hasProfiles: false },
    { label: 'Opera GX', ...browserPaths.operaGX, hasProfiles: false },
    { label: 'Arc', ...browserPaths.arc, hasProfiles: true },
    { label: 'Chromium', ...browserPaths.chromium, hasProfiles: true },
    { label: 'Thorium', ...browserPaths.thorium, hasProfiles: true },
    { label: 'Supermium', ...browserPaths.supermium, hasProfiles: true },
    { label: 'Helium', ...browserPaths.helium, hasProfiles: true },
    { label: 'Cromite', ...browserPaths.cromite, hasProfiles: true },
    { label: 'CatsXP', ...browserPaths.catsxp, hasProfiles: true },
  ]
  for (const browser of chromiumBrowsers) {
    if (!existsSync(browser.base)) continue
    if (browser.hasProfiles) {
      const profiles = await getChromiumProfiles(browser.base)
      for (const profile of profiles) {
        for (const { dir, label } of [
          { dir: browser.cache, label: 'Cache' }, { dir: browser.codeCache, label: 'Code Cache' },
          { dir: browser.gpuCache, label: 'GPU Cache' }, { dir: browser.serviceWorker, label: 'Service Worker Cache' },
        ]) {
          const cachePath = join(browser.base, profile, dir)
          if (existsSync(cachePath)) {
            const result = await scanDirectory(cachePath, category, `${browser.label} - ${profile} ${label}`)
            if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
          }
        }
      }
    } else {
      for (const { dir, label } of [
        { dir: browser.cache, label: 'Cache' }, { dir: browser.codeCache, label: 'Code Cache' },
        { dir: browser.gpuCache, label: 'GPU Cache' }, { dir: browser.serviceWorker, label: 'Service Worker Cache' },
      ]) {
        const cachePath = join(browser.base, dir)
        if (existsSync(cachePath)) {
          const result = await scanDirectory(cachePath, category, `${browser.label} - ${label}`)
          if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
        }
      }
    }
  }
  if (existsSync(browserPaths.firefox.cache)) {
    try {
      const profileDirs = await readdir(browserPaths.firefox.cache, { withFileTypes: true })
      for (const dir of profileDirs) {
        if (dir.isDirectory()) {
          const cachePath = join(browserPaths.firefox.cache, dir.name, 'cache2', 'entries')
          if (existsSync(cachePath)) {
            const result = await scanDirectory(cachePath, category, `Firefox - ${dir.name} Cache`)
            if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
          }
        }
      }
    } catch { /* skip */ }
  }
  // Firefox forks (LibreWolf, Waterfox, Floorp)
  const firefoxForks = [
    { label: 'LibreWolf', ...browserPaths.librewolf },
    { label: 'Waterfox', ...browserPaths.waterfox },
    { label: 'Floorp', ...browserPaths.floorp },
  ]
  for (const fork of firefoxForks) {
    if (!fork.cache || !existsSync(fork.cache)) continue
    try {
      const profileDirs = await readdir(fork.cache, { withFileTypes: true })
      for (const dir of profileDirs) {
        if (dir.isDirectory()) {
          const cachePath = join(fork.cache, dir.name, 'cache2')
          if (existsSync(cachePath)) {
            const result = await scanDirectory(cachePath, category, `${fork.label} - ${dir.name} Cache`)
            if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
          }
        }
      }
    } catch { /* skip */ }
  }
  // Safari (macOS only) — cache directory only, never cookies/history/bookmarks
  if (browserPaths.safari && existsSync(browserPaths.safari.cache)) {
    const result = await scanDirectory(browserPaths.safari.cache, category, 'Safari - Cache')
    if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
  }
  return results
}

async function scanApp(): Promise<ScanResult[]> {
  const results: ScanResult[] = []
  const category = CleanerType.App
  for (const appDef of getPlatform().paths.appPaths()) {
    try {
      const paths = await resolveChildSubdirs(appDef.paths, appDef.childSubdir)
      const result = await scanMultipleDirectories(paths, category, appDef.name)
      if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
    } catch { /* skip */ }
  }
  return results
}

async function scanGaming(): Promise<ScanResult[]> {
  const results: ScanResult[] = []
  const category = CleanerType.Gaming
  for (const launcher of getPlatform().paths.gamingPaths()) {
    try {
      const result = await scanDirectoriesAsItems(launcher.paths, category, launcher.name, 'Launcher Caches')
      if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
    } catch { /* skip */ }
  }
  for (const gpu of getPlatform().paths.gpuCachePaths()) {
    try {
      const result = await scanDirectoriesAsItems(gpu.paths, category, gpu.name, 'GPU Shader Caches')
      if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
    } catch { /* skip */ }
  }
  return results
}

async function scanRecycleBin(): Promise<ScanResult[]> {
  const trashPath = getPlatform().paths.trashPath()
  if (trashPath) {
    // macOS / Linux: scan trash directory
    if (!existsSync(trashPath)) return []
    const result = await scanDirectory(trashPath, CleanerType.RecycleBin, 'Trash', 0)
    if (result.items.length > 0) { cacheItems(result.items); return [result] }
    return []
  }
  // Windows: COM-based recycle bin
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)
  try {
    const rbScript = `$shell = New-Object -ComObject Shell.Application; $rb = $shell.NameSpace(0x0a); $items = $rb.Items(); $count = $items.Count; $size = ($items | Measure-Object -Property Size -Sum).Sum; Write-Output "$count|$size"`
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command', psUtf8(rbScript)
    ], { windowsHide: true })
    const [countStr, sizeStr] = stdout.trim().split('|')
    const count = parseInt(countStr) || 0
    const size = parseInt(sizeStr) || 0
    if (count === 0) return []
    const item = { id: randomUUID(), path: 'Recycle Bin', size, category: CleanerType.RecycleBin, subcategory: 'Recycle Bin', lastModified: Date.now(), selected: true }
    cacheItems([item])
    return [{ category: CleanerType.RecycleBin, subcategory: 'Recycle Bin', items: [item], totalSize: size, itemCount: count }]
  } catch { return [] }
}

async function scanDatabaseCli(): Promise<ScanResult[]> {
  const results: ScanResult[] = []
  const category = CleanerType.Database
  const targets = getPlatform().paths.databaseOptimizeTargets()
  const { statSync, existsSync: fileExists, readdirSync, openSync, readSync, closeSync } = await import('fs')
  const path = await import('path')

  function isSqliteFile(filePath: string): boolean {
    let fd: number | undefined
    try {
      fd = openSync(filePath, 'r')
      const buf = Buffer.alloc(16)
      readSync(fd, buf, 0, 16, 0)
      return buf.toString('utf8', 0, 16) === 'SQLite format 3\0'
    } catch { return false }
    finally { if (fd !== undefined) closeSync(fd) }
  }

  for (const target of targets) {
    try {
      if (!fileExists(target.basePath)) continue
      const items: ScanResult['items'] = []

      let profileDirs = [target.basePath]
      if (target.multiProfile) {
        try {
          const entries = readdirSync(target.basePath, { withFileTypes: true })
          const dirs: string[] = []
          if (target.profilePattern) {
            for (const entry of entries) {
              if (!entry.isDirectory()) continue
              for (const pattern of target.profilePattern) {
                const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
                if (new RegExp('^' + escaped + '$').test(entry.name)) { dirs.push(path.join(target.basePath, entry.name)); break }
              }
            }
          } else {
            for (const entry of entries) {
              if (!entry.isDirectory()) continue
              if (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)) {
                dirs.push(path.join(target.basePath, entry.name))
              }
            }
          }
          if (dirs.length > 0) profileDirs = dirs
        } catch { /* use basePath */ }
      }

      for (const profileDir of profileDirs) {
        for (const dbFile of target.dbFiles) {
          const dbPath = path.join(profileDir, dbFile)
          if (!fileExists(dbPath) || !isSqliteFile(dbPath)) continue
          const fileStat = statSync(dbPath)
          if (fileStat.size === 0) continue

          let walSize = 0
          try { walSize = statSync(dbPath + '-wal').size } catch { /* no WAL */ }
          const wastedBytes = walSize + Math.floor(fileStat.size * 0.1)
          if (wastedBytes < 4096) continue

          items.push({
              id: randomUUID(), path: dbPath, size: wastedBytes,
              category, subcategory: target.label,
              lastModified: fileStat.mtimeMs, selected: true,
            })
        }
      }

      if (items.length > 0) {
        cacheItems(items)
        results.push({ category, subcategory: target.label, items, totalSize: items.reduce((s, i) => s + i.size, 0), itemCount: items.length })
      }
    } catch { /* skip */ }
  }
  return results
}

async function cleanRecycleBin(sizeBytes: number = 0): Promise<CleanResult> {
  // On macOS/Linux, trash items are real files cleaned via cleanItems() in the main flow.
  // This function is only called for Windows COM-based recycle bin.
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)
  try {
    const cleanScript = `$shell = New-Object -ComObject Shell.Application; $shell.NameSpace(0x0a).Items() | ForEach-Object { Remove-Item $_.Path -Recurse -Force -ErrorAction SilentlyContinue }; Clear-RecycleBin -Force -Confirm:$false -ErrorAction SilentlyContinue`
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command', psUtf8(cleanScript)
    ], { windowsHide: true })
    return { totalCleaned: sizeBytes, filesDeleted: 1, filesSkipped: 0, errors: [], needsElevation: false }
  } catch (err: any) {
    return { totalCleaned: 0, filesDeleted: 0, filesSkipped: 0, errors: [{ path: 'Recycle Bin', reason: err.message }], needsElevation: false }
  }
}

async function cleanDatabasesCli(itemIds: string[]): Promise<CleanResult> {
  const { getCachedItem } = await import('./services/scan-cache')
  const { statSync } = await import('fs')
  const Database = (await import('better-sqlite3')).default
  let totalCleaned = 0, filesDeleted = 0, filesSkipped = 0
  const errors: CleanResult['errors'] = []

  for (const id of itemIds) {
    const item = getCachedItem(id)
    if (!item) continue
    try {
      const sizeBefore = statSync(item.path).size
      let walSizeBefore = 0
      try { walSizeBefore = statSync(item.path + '-wal').size } catch { /* no WAL */ }
      const db = new Database(item.path, { fileMustExist: true })
      try {
        const journalMode = (db.pragma('journal_mode', { simple: true }) as string).toLowerCase()
        db.exec('VACUUM')
        if (journalMode === 'wal') db.pragma('journal_mode = WAL')
      } finally { db.close() }
      const sizeAfter = statSync(item.path).size
      let walSizeAfter = 0
      try { walSizeAfter = statSync(item.path + '-wal').size } catch { /* no WAL */ }
      const reclaimed = (sizeBefore + walSizeBefore) - (sizeAfter + walSizeAfter)
      if (reclaimed > 0) totalCleaned += reclaimed
      filesDeleted++
    } catch (err: unknown) {
      filesSkipped++
      const code = (err as { code?: string }).code
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'EBUSY') {
        errors.push({ path: item.path, reason: 'in-use' })
      } else if (code === 'EPERM' || code === 'EACCES') {
        errors.push({ path: item.path, reason: 'permission-denied' })
      } else {
        errors.push({ path: item.path, reason: (err as Error).message || 'unknown error' })
      }
    }
  }
  return { totalCleaned, filesDeleted, filesSkipped, errors, needsElevation: errors.some((e) => e.reason === 'permission-denied') }
}

async function getChromiumProfiles(basePath: string): Promise<string[]> {
  const profiles = ['Default']
  try {
    const entries = await readdir(basePath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('Profile ')) profiles.push(entry.name)
    }
  } catch { /* skip */ }
  return profiles
}

// ─── Help text ───────────────────────────────────────────────

function printHelp(): void {
  log(`
Kudu CLI — Full-featured command line interface

Usage:
  kudu --cli <command> [subcommand] [options]
  kudu --daemon [--api-key <key>]

Daemon Mode (headless cloud agent):
  --daemon                     Start as headless cloud agent daemon
  --daemon --api-key <key>     Set API key and start daemon

File Cleaners (legacy flags also supported):
  scan [--system] [--browser] [--app] [--gaming] [--recycle-bin] [--all]
  clean [--system] [--browser] [--app] [--gaming] [--recycle-bin] [--all]

Registry:
  registry scan              Scan for registry issues
  registry fix [--all]       Fix found registry issues

Startup Manager:
  startup list               List startup items
  startup boot-trace         Show boot time trace
  startup disable <name>     Disable a startup item
  startup enable <name>      Enable a startup item
  startup delete <name>      Delete a startup item

Debloater:
  debloat scan               Scan for removable bloatware
  debloat remove <pkg,...>   Remove specified packages (comma-separated)
  debloat remove --all       Remove all detected bloatware

Disk Analyzer:
  disk drives                List available drives
  disk analyze <drive>       Analyze disk usage (e.g. disk analyze C)
  disk file-types <drive>    Analyze file types on a drive

Network Cleanup:
  network scan               Scan DNS cache, Wi-Fi profiles, ARP cache
  network clean [--all]      Clean selected network items

Malware Scanner:
  malware scan               Scan for malware threats
  malware quarantine <path>  Quarantine a detected file
  malware delete <path>      Delete a detected file

Privacy Shield:
  privacy scan               Scan privacy settings
  privacy apply [--all]      Apply recommended privacy settings

Driver Manager:
  drivers scan               Scan for old/unused driver packages
  drivers clean <name,...>   Remove specified driver packages
  drivers check-updates      Check for driver updates
  drivers update [--all]     Install driver updates

Service Manager:
  services scan              Scan Windows services
  services disable <name>    Set service to disabled
  services manual <name>     Set service to manual start

Program Uninstaller:
  programs list              List installed programs

Software Updater:
  updates check              Check for software updates (via winget)
  updates run <id,...>       Update specified apps
  updates run --all          Update all available apps

Performance Monitor:
  perf info                  Show system information
  perf disk-health           Show disk S.M.A.R.T. health
  perf kill <pid>            Kill a process by PID

Uninstall Leftovers:
  leftovers scan             Scan for uninstall leftovers
  leftovers clean            Clean found leftovers

CVE Scanner:
  cve list                   List known CVE vulnerabilities (requires cloud agent)

Scan History:
  history list               Show scan history
  history clear              Clear scan history

Restore Points:
  restore-point create [description]   Create a system restore point

Config Management:
  config get [key]             Show settings (e.g. config get cloud.apiKey)
  config set <key> <value>     Update a setting (e.g. config set cloud.apiKey my-key)

Service Management (Linux):
  service install              Install as a systemd service
  service uninstall            Remove the systemd service
  service status               Show service status

Prometheus Metrics:
  metrics                    Print current metrics (Prometheus text format)
  metrics-server [--port N]  Start HTTP metrics endpoint (default: port 9100)

Global Options:
  --json          Output as JSON
  --verbose       Show detailed progress, timing, and debug info
  -q, --quiet     Suppress all output except errors and final result
  --all           Select all items for action commands
  -h, --help      Show this help
  -v, --version   Show version

Exit Codes:
  0  Success
  1  General error
  2  Invalid arguments
  3  Permission denied (needs elevation)
  4  Partial success (some operations failed)
  5  Nothing found (scan returned zero items)
  6  Unknown command
  7  Threats/issues found requiring attention

Examples:
  kudu --cli scan --all --clean        Scan & clean all file categories
  kudu --cli registry scan --json      Scan registry, JSON output
  kudu --cli debloat scan              List removable bloatware
  kudu --cli startup list              Show startup items
  kudu --cli malware scan              Run malware scan
  kudu --cli perf info                 Show system specs
  kudu --cli config set cloud.apiKey my-key   Set cloud API key
  kudu --cli metrics                   Print Prometheus metrics
  kudu --cli metrics-server --port 9200  Start metrics endpoint
  kudu --daemon                        Run headless cloud agent
  sudo kudu --cli service install      Install as Linux service
`.trim())
}

// ─── Subcommand handlers ─────────────────────────────────────

async function handleRegistry(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { scanRegistry, fixRegistryEntries } = await import('./ipc/registry-cleaner.ipc')

  if (sub === 'scan') {
    cliLog(ctx, 'Scanning registry...')
    const startTime = Date.now()
    const entries = await scanRegistry()
    cliVerbose(ctx, `Registry scan completed in ${Date.now() - startTime}ms`)
    if (ctx.json) {
      cliOut(ctx, { entries, count: entries.length })
    } else {
      cliLog(ctx, `Found ${entries.length} registry issues`)
      for (const e of entries) cliLog(ctx, `  [${e.risk}] ${e.keyPath} — ${e.issue}`)
    }
  } else if (sub === 'fix') {
    cliLog(ctx, 'Scanning registry...')
    const entries = await scanRegistry()
    if (entries.length === 0) {
      cliOut(ctx, ctx.json ? { message: 'No issues found' } : 'No registry issues found.')
      return
    }
    const toFix = args.includes('--all') ? entries : entries.filter(e => e.risk === 'high')
    cliLog(ctx, `Fixing ${toFix.length} of ${entries.length} issues...`)
    const result = await fixRegistryEntries(toFix, (current, total) => {
      if (showProgress(ctx)) process.stdout.write(`\r  Progress: ${current}/${total}`)
    })
    if (showProgress(ctx)) log('')
    cliOut(ctx, result)
  } else {
    cliUsage(ctx, 'kudu --cli registry <scan|fix> [--all] [--json]')
    return ExitCode.INVALID_ARGS
  }
}

async function handleStartup(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { listStartupItems, toggleStartupItem, deleteStartupItem, getBootTrace } = await import('./ipc/startup-manager.ipc')

  if (sub === 'list') {
    const items = await listStartupItems()
    if (ctx.json) {
      cliOut(ctx, items)
    } else {
      cliLog(ctx, `Found ${items.length} startup items`)
      for (const item of items) {
        const status = item.enabled ? 'enabled' : 'disabled'
        cliLog(ctx, `  [${status}] ${item.displayName || item.name} — ${item.impact || 'unknown'} impact`)
      }
    }
  } else if (sub === 'boot-trace') {
    const trace = await getBootTrace()
    cliOut(ctx, trace)
  } else if (sub === 'disable' || sub === 'enable') {
    const name = args.slice(1).join(' ')
    if (!name) { cliUsage(ctx, `kudu --cli startup ${sub} <name>`); return ExitCode.INVALID_ARGS }
    const items = await listStartupItems()
    const item = items.find(i => i.name === name || i.displayName === name)
    if (!item) { cliNotFound(ctx, 'Startup item', name); return ExitCode.NOTHING_FOUND }
    const enabled = sub === 'enable'
    const result = await toggleStartupItem(item.name, item.location, item.command, item.source, enabled)
    cliOut(ctx, result)
  } else if (sub === 'delete') {
    const name = args.slice(1).join(' ')
    if (!name) { cliUsage(ctx, 'kudu --cli startup delete <name>'); return ExitCode.INVALID_ARGS }
    const items = await listStartupItems()
    const item = items.find(i => i.name === name || i.displayName === name)
    if (!item) { cliNotFound(ctx, 'Startup item', name); return ExitCode.NOTHING_FOUND }
    const result = await deleteStartupItem(item.name, item.location, item.source)
    cliOut(ctx, result)
  } else {
    cliUsage(ctx, 'kudu --cli startup <list|boot-trace|disable|enable|delete> [name]')
    return ExitCode.INVALID_ARGS
  }
}

async function handleDebloat(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { scanBloatware, removeBloatware } = await import('./ipc/debloater.ipc')

  if (sub === 'scan') {
    cliLog(ctx, 'Scanning for bloatware...')
    const apps = await scanBloatware()
    if (ctx.json) {
      cliOut(ctx, { apps, count: apps.length })
    } else {
      cliLog(ctx, `Found ${apps.length} removable apps`)
      for (const a of apps) cliLog(ctx, `  ${a.name} (${a.packageName}) — ${a.size} — ${a.description}`)
    }
  } else if (sub === 'remove') {
    const allFlag = args.includes('--all')
    if (allFlag) {
      cliLog(ctx, 'Scanning for bloatware...')
      const apps = await scanBloatware()
      if (apps.length === 0) { cliOut(ctx, ctx.json ? { message: 'No bloatware found' } : 'No bloatware found.'); return }
      const packageNames = apps.map(a => a.packageName)
      cliLog(ctx, `Removing ${packageNames.length} apps...`)
      const result = await removeBloatware(packageNames, (current, total, currentApp, status) => {
        cliLog(ctx, `  [${current}/${total}] ${currentApp}: ${status}`)
      })
      cliOut(ctx, result)
    } else {
      const pkgArg = args.find(a => a !== 'remove' && !a.startsWith('--'))
      if (!pkgArg) { cliUsage(ctx, 'kudu --cli debloat remove <pkg1,pkg2,...> or --all'); return ExitCode.INVALID_ARGS }
      const packageNames = pkgArg.split(',').map(s => s.trim()).filter(Boolean)
      cliLog(ctx, `Removing ${packageNames.length} apps...`)
      const result = await removeBloatware(packageNames, (current, total, currentApp, status) => {
        cliLog(ctx, `  [${current}/${total}] ${currentApp}: ${status}`)
      })
      cliOut(ctx, result)
    }
  } else {
    cliUsage(ctx, 'kudu --cli debloat <scan|remove> [packages|--all]')
    return ExitCode.INVALID_ARGS
  }
}

async function handleDisk(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { getDrives, analyzeDisk, getFileTypes } = await import('./ipc/disk-analyzer.ipc')

  if (sub === 'drives') {
    const drives = await getDrives()
    if (ctx.json) {
      cliOut(ctx, drives)
    } else {
      for (const d of drives) cliLog(ctx, `  ${d.letter}: ${d.label || 'Local Disk'} — ${formatBytes(d.usedSpace)} / ${formatBytes(d.totalSize)} (${(d.usedSpace / d.totalSize * 100).toFixed(1)}% used)`)
    }
  } else if (sub === 'analyze') {
    const drive = args[1]?.replace(':', '')
    if (!drive) { cliUsage(ctx, 'kudu --cli disk analyze <drive-letter>'); return ExitCode.INVALID_ARGS }
    cliLog(ctx, `Analyzing drive ${drive}:...`)
    const tree = await analyzeDisk(drive)
    if (ctx.json) {
      cliOut(ctx, tree)
    } else {
      const printNode = (node: any, depth: number): void => {
        if (depth > 2) return
        cliLog(ctx, `${'  '.repeat(depth + 1)}${node.name} — ${formatBytes(node.size)}`)
        if (node.children) for (const child of node.children.slice(0, 10)) printNode(child, depth + 1)
      }
      printNode(tree, 0)
    }
  } else if (sub === 'file-types') {
    const drive = args[1]?.replace(':', '')
    if (!drive) { cliUsage(ctx, 'kudu --cli disk file-types <drive-letter>'); return ExitCode.INVALID_ARGS }
    cliLog(ctx, `Analyzing file types on ${drive}:...`)
    const types = await getFileTypes(drive)
    if (ctx.json) {
      cliOut(ctx, types)
    } else {
      for (const t of types) cliLog(ctx, `  ${t.extension}: ${t.fileCount} files, ${formatBytes(t.totalSize)}`)
    }
  } else {
    cliUsage(ctx, 'kudu --cli disk <drives|analyze|file-types> [drive-letter]')
    return ExitCode.INVALID_ARGS
  }
}

async function handleNetwork(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { scanNetwork, cleanNetworkItems } = await import('./ipc/network-cleanup.ipc')

  if (sub === 'scan') {
    cliLog(ctx, 'Scanning network...')
    const items = await scanNetwork()
    if (ctx.json) {
      cliOut(ctx, { items, count: items.length })
    } else {
      cliLog(ctx, `Found ${items.length} network items`)
      for (const item of items) cliLog(ctx, `  [${item.type}] ${item.label} — ${item.detail}`)
    }
  } else if (sub === 'clean') {
    cliLog(ctx, 'Scanning network...')
    const items = await scanNetwork()
    if (items.length === 0) { cliOut(ctx, ctx.json ? { message: 'Nothing to clean' } : 'No network items found.'); return }
    const toClean = args.includes('--all') ? items : items.filter(i => i.selected)
    cliLog(ctx, `Cleaning ${toClean.length} items...`)
    const result = await cleanNetworkItems(toClean)
    cliOut(ctx, result)
  } else {
    cliUsage(ctx, 'kudu --cli network <scan|clean> [--all]')
    return ExitCode.INVALID_ARGS
  }
}

async function handleMalware(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { scanMalware, quarantineMalware, deleteMalware } = await import('./ipc/malware-scanner.ipc')

  if (sub === 'scan') {
    cliLog(ctx, 'Scanning for malware...')
    const startTime = Date.now()
    const result = await scanMalware((progress) => {
      if (showProgress(ctx)) process.stdout.write(`\r  Scanning: ${progress.currentPath || '...'}`)
    })
    if (showProgress(ctx)) log('')
    cliVerbose(ctx, `Malware scan completed in ${Date.now() - startTime}ms`)
    if (ctx.json) {
      cliOut(ctx, { threats: result.threats, count: result.threats.length })
    } else {
      cliLog(ctx, `Found ${result.threats.length} threats`)
      for (const t of result.threats) cliLog(ctx, `  [${t.severity}] ${t.fileName} — ${t.path}`)
    }
    if (result.threats.length > 0) return ExitCode.SCAN_THREATS
  } else if (sub === 'quarantine') {
    const path = args.slice(1).filter(a => !a.startsWith('--')).join(' ')
    if (!path) { cliUsage(ctx, 'kudu --cli malware quarantine <path>'); return ExitCode.INVALID_ARGS }
    const result = await quarantineMalware([path])
    cliOut(ctx, result)
  } else if (sub === 'delete') {
    const path = args.slice(1).filter(a => !a.startsWith('--')).join(' ')
    if (!path) { cliUsage(ctx, 'kudu --cli malware delete <path>'); return ExitCode.INVALID_ARGS }
    const result = await deleteMalware([path])
    cliOut(ctx, result)
  } else {
    cliUsage(ctx, 'kudu --cli malware <scan|quarantine|delete> [path]')
    return ExitCode.INVALID_ARGS
  }
}

async function handlePrivacy(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { scanPrivacy, applyPrivacySettings } = await import('./ipc/privacy-shield.ipc')

  if (sub === 'scan') {
    cliLog(ctx, 'Scanning privacy settings...')
    const result = await scanPrivacy()
    if (ctx.json) {
      cliOut(ctx, { settings: result.settings, count: result.settings.length })
    } else {
      cliLog(ctx, `Found ${result.settings.length} privacy settings`)
      for (const s of result.settings) {
        const status = s.enabled ? 'ON' : 'OFF'
        cliLog(ctx, `  [${status}] ${s.label} — ${s.description}`)
      }
    }
  } else if (sub === 'apply') {
    cliLog(ctx, 'Scanning privacy settings...')
    const scanResult = await scanPrivacy()
    const toApply = args.includes('--all')
      ? scanResult.settings.map(s => s.id)
      : scanResult.settings.filter(s => !s.enabled).map(s => s.id)
    if (toApply.length === 0) { cliOut(ctx, ctx.json ? { message: 'Nothing to apply' } : 'All recommended settings already applied.'); return }
    cliLog(ctx, `Applying ${toApply.length} privacy settings...`)
    const applyResult = await applyPrivacySettings(toApply)
    cliOut(ctx, applyResult)
  } else {
    cliUsage(ctx, 'kudu --cli privacy <scan|apply> [--all]')
    return ExitCode.INVALID_ARGS
  }
}

async function handleDrivers(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { scanDrivers, cleanDrivers, scanDriverUpdates, installDriverUpdates } = await import('./ipc/driver-manager.ipc')

  if (sub === 'scan') {
    cliLog(ctx, 'Scanning driver packages...')
    const result = await scanDrivers((progress) => {
      if (showProgress(ctx)) process.stdout.write(`\r  ${progress}`)
    })
    if (showProgress(ctx)) log('')
    if (ctx.json) {
      cliOut(ctx, { packages: result.packages, count: result.packages.length })
    } else {
      cliLog(ctx, `Found ${result.packages.length} driver packages`)
      for (const p of result.packages) cliLog(ctx, `  ${p.publishedName} — ${p.className} — ${p.version}`)
    }
  } else if (sub === 'clean') {
    const nameArg = args.find(a => a !== 'clean' && !a.startsWith('--'))
    if (!nameArg) { cliUsage(ctx, 'kudu --cli drivers clean <name1,name2,...>'); return ExitCode.INVALID_ARGS }
    const names = nameArg.split(',').map(s => s.trim()).filter(Boolean)
    cliLog(ctx, `Removing ${names.length} driver packages...`)
    const result = await cleanDrivers(names)
    cliOut(ctx, result)
  } else if (sub === 'check-updates') {
    cliLog(ctx, 'Checking for driver updates...')
    const updateResult = await scanDriverUpdates((progress) => {
      if (showProgress(ctx)) process.stdout.write(`\r  ${progress}`)
    })
    if (showProgress(ctx)) log('')
    if (ctx.json) {
      cliOut(ctx, { updates: updateResult.updates, count: updateResult.updates.length, updatesDisabled: updateResult.updatesDisabled })
    } else if (updateResult.updatesDisabled) {
      cliLog(ctx, 'Driver updates are turned off in Windows (excluded from Windows Update); skipped.')
    } else {
      cliLog(ctx, `Found ${updateResult.updates.length} driver updates`)
      for (const u of updateResult.updates) cliLog(ctx, `  ${u.updateTitle}`)
    }
  } else if (sub === 'update') {
    cliLog(ctx, 'Checking for driver updates...')
    const updateResult = await scanDriverUpdates()
    if (updateResult.updates.length === 0) { cliOut(ctx, ctx.json ? { message: 'No updates available' } : 'Drivers are up to date.'); return }
    const toInstall = args.includes('--all')
      ? updateResult.updates.map(u => u.updateId)
      : (() => {
          const idArg = args.find(a => a !== 'update' && !a.startsWith('--'))
          return idArg ? idArg.split(',').map(s => s.trim()).filter(Boolean) : []
        })()
    if (toInstall.length === 0) { cliUsage(ctx, 'kudu --cli drivers update <id,...> or --all'); return ExitCode.INVALID_ARGS }
    cliLog(ctx, `Installing ${toInstall.length} driver updates...`)
    const result = await installDriverUpdates(toInstall, (progress) => {
      if (showProgress(ctx)) process.stdout.write(`\r  ${progress}`)
    })
    if (showProgress(ctx)) log('')
    cliOut(ctx, result)
  } else {
    cliUsage(ctx, 'kudu --cli drivers <scan|clean|check-updates|update> [names|--all]')
    return ExitCode.INVALID_ARGS
  }
}

async function handleServices(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { scanServices, applyServiceChanges } = await import('./ipc/service-manager.ipc')

  if (sub === 'scan') {
    cliLog(ctx, 'Scanning services...')
    const result = await scanServices()
    if (ctx.json) {
      cliOut(ctx, { services: result.services, count: result.services.length })
    } else {
      cliLog(ctx, `Found ${result.services.length} optimizable services`)
      for (const s of result.services) cliLog(ctx, `  [${s.startType}] ${s.displayName} (${s.name}) — ${s.description || ''}`)
    }
  } else if (sub === 'disable' || sub === 'manual') {
    const name = args.slice(1).filter(a => !a.startsWith('--')).join(' ')
    if (!name) { cliUsage(ctx, `kudu --cli services ${sub} <service-name>`); return ExitCode.INVALID_ARGS }
    const targetType = sub === 'disable' ? 'Disabled' : 'Manual'
    cliLog(ctx, `Setting ${name} to ${targetType}...`)
    const result = await applyServiceChanges([{ name, targetStartType: targetType }])
    cliOut(ctx, result)
  } else {
    cliUsage(ctx, 'kudu --cli services <scan|disable|manual> [service-name]')
    return ExitCode.INVALID_ARGS
  }
}

async function handlePrograms(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { getInstalledProgramsFull } = await import('./services/program-uninstaller')

  if (sub === 'list') {
    cliLog(ctx, 'Loading installed programs...')
    const programs = await getInstalledProgramsFull()
    if (ctx.json) {
      cliOut(ctx, { programs, count: programs.length })
    } else {
      cliLog(ctx, `Found ${programs.length} installed programs`)
      for (const p of programs) cliLog(ctx, `  ${p.displayName} ${p.displayVersion || ''} — ${p.publisher || 'Unknown publisher'} — ${p.estimatedSize ? formatBytes(p.estimatedSize * 1024) : ''}`)
    }
  } else {
    cliUsage(ctx, 'kudu --cli programs list')
    return ExitCode.INVALID_ARGS
  }
}

async function handleUpdates(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { checkForUpdates, runUpdates } = await import('./services/software-updater')

  if (sub === 'check') {
    cliLog(ctx, 'Checking for software updates...')
    const result = await checkForUpdates()
    if (ctx.json) {
      cliOut(ctx, result)
    } else {
      if (!result.packageManagerAvailable) { cliLog(ctx, `  ${result.packageManagerName ?? 'package manager'} is not available on this system`); return }
      cliLog(ctx, `Found ${result.apps.length} available updates, ${result.upToDate.length} up to date`)
      for (const a of result.apps) cliLog(ctx, `  ${a.name}: ${a.currentVersion} → ${a.availableVersion} (${a.severity})`)
    }
  } else if (sub === 'run') {
    cliLog(ctx, 'Checking for software updates...')
    const check = await checkForUpdates()
    if (check.apps.length === 0) { cliOut(ctx, ctx.json ? { message: 'Everything up to date' } : 'All software is up to date.'); return }
    const allFlag = args.includes('--all')
    // --all: take apps (with their source) directly so aggregation duplicates
    // like choco/git + scoop/git each keep their own manager. Explicit ids:
    // resolve each id's source from the scan (fall back to the primary manager).
    let items: { id: string; source: string }[]
    if (allFlag) {
      items = check.apps.map(a => ({ id: a.id, source: a.source }))
    } else {
      const idArg = args.find(a => a !== 'run' && !a.startsWith('--'))
      const ids = idArg ? idArg.split(',').map(s => s.trim()).filter(Boolean) : []
      const sourceById = new Map(check.apps.map(a => [a.id, a.source]))
      items = ids.map(id => ({ id, source: sourceById.get(id) ?? check.packageManagerName ?? 'winget' }))
    }
    if (items.length === 0) { cliUsage(ctx, 'kudu --cli updates run <id,...> or --all'); return ExitCode.INVALID_ARGS }
    cliLog(ctx, `Updating ${items.length} apps...`)
    const result = await runUpdates(items, (progress) => {
      cliLog(ctx, `  [${progress.current}/${progress.total}] ${progress.currentApp}: ${progress.status}`)
    })
    cliOut(ctx, result)
  } else {
    cliUsage(ctx, 'kudu --cli updates <check|run> [ids|--all]')
    return ExitCode.INVALID_ARGS
  }
}

async function handlePerf(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { PerfMonitorService } = await import('./services/perf-monitor')
  const perf = new PerfMonitorService()

  if (sub === 'info') {
    const info = await perf.getSystemInfo()
    if (ctx.json) {
      cliOut(ctx, info)
    } else {
      cliLog(ctx, `  CPU: ${info.cpuModel} (${info.cpuCores}C/${info.cpuThreads}T)`)
      cliLog(ctx, `  RAM: ${formatBytes(info.totalMemBytes)}`)
      cliLog(ctx, `  OS:  ${info.osVersion}`)
      cliLog(ctx, `  Host: ${info.hostname}`)
    }
  } else if (sub === 'disk-health') {
    cliLog(ctx, 'Checking disk health...')
    const disks = await perf.getDiskHealth()
    if (ctx.json) {
      cliOut(ctx, disks)
    } else {
      for (const d of disks) {
        cliLog(ctx, `  ${d.model} (${d.type}) — ${d.healthStatus}`)
        if (d.temperature) cliLog(ctx, `    Temperature: ${d.temperature}°C`)
        if (d.remainingLife !== null) cliLog(ctx, `    Remaining life: ${d.remainingLife}%`)
        if (d.powerOnHours !== null) cliLog(ctx, `    Power-on hours: ${d.powerOnHours}`)
      }
    }
  } else if (sub === 'kill') {
    const pid = parseInt(args[1])
    if (isNaN(pid)) { cliUsage(ctx, 'kudu --cli perf kill <pid>'); return ExitCode.INVALID_ARGS }
    const result = await perf.killProcess(pid)
    cliOut(ctx, result)
  } else {
    cliUsage(ctx, 'kudu --cli perf <info|disk-health|kill> [pid]')
    return ExitCode.INVALID_ARGS
  }
}

async function handleLeftovers(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { scanForLeftovers } = await import('./services/uninstall-leftovers')

  if (sub === 'scan' || sub === 'clean') {
    cliLog(ctx, 'Scanning for uninstall leftovers...')
    const results = await scanForLeftovers(() => null)
    const totalItems = results.reduce((s, r) => s + r.itemCount, 0)
    const totalSize = results.reduce((s, r) => s + r.totalSize, 0)
    if (ctx.json && sub === 'scan') {
      cliOut(ctx, { results, totalItems, totalSize })
    } else if (sub === 'scan') {
      cliLog(ctx, `Found ${totalItems} leftover items (${formatBytes(totalSize)})`)
      for (const r of results) cliLog(ctx, `  ${r.subcategory}: ${r.itemCount} items, ${formatBytes(r.totalSize)}`)
    }
    if (sub === 'clean') {
      if (totalItems === 0) { cliOut(ctx, ctx.json ? { message: 'No leftovers found' } : 'No leftovers found.'); return ExitCode.NOTHING_FOUND }
      cliLog(ctx, `Cleaning ${totalItems} items (${formatBytes(totalSize)})...`)
      const itemIds = results.flatMap(r => r.items.map(i => i.id))
      const cleanResult = await cleanItems(itemIds)
      cliOut(ctx, cleanResult)
    }
  } else {
    cliUsage(ctx, 'kudu --cli leftovers <scan|clean>')
    return ExitCode.INVALID_ARGS
  }
}

async function handleCve(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]

  if (sub === 'list') {
    const { cloudAgent } = await import('./services/cloud-agent')
    const { getSettings } = await import('./services/settings-store')
    if (!getSettings().cloud.apiKey) {
      cliOut(ctx, ctx.json ? { error: 'No cloud API key configured' } : 'No cloud API key configured. Link via Settings → Cloud.')
      return ExitCode.GENERAL_ERROR
    }
    // Start cloud agent (CLI mode doesn't auto-start it) and wait for subscription
    if (cloudAgent.getStatus().status !== 'connected') {
      if (!ctx.json) cliLog(ctx, 'Connecting to cloud...')
      await cloudAgent.start()
      // start() returns before the Pusher subscription completes — poll for connected
      const deadline = Date.now() + 15_000
      while (cloudAgent.getStatus().status !== 'connected' && Date.now() < deadline) {
        if (cloudAgent.getStatus().status === 'error' || cloudAgent.getStatus().status === 'dormant') break
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    if (cloudAgent.getStatus().status !== 'connected') {
      cliOut(ctx, ctx.json ? { error: 'Cloud agent failed to connect' } : 'Cloud agent failed to connect. Check your API key and network.')
      return ExitCode.GENERAL_ERROR
    }
    if (!ctx.json) cliLog(ctx, 'Fetching vulnerabilities...')
    try {
      const firstPage = await cloudAgent.getVulnerabilities()
      if (ctx.json) {
        // Fetch all pages so --json output is complete
        const allVulns = [...firstPage.vulnerabilities]
        let page = 2
        let hasMore = firstPage.nextPageUrl !== null
        while (hasMore) {
          const next = await cloudAgent.getVulnerabilities(page)
          allVulns.push(...next.vulnerabilities)
          hasMore = next.nextPageUrl !== null
          page++
        }
        cliOut(ctx, { vulnerabilities: allVulns, summary: firstPage.summary, total: firstPage.total, librarySize: firstPage.librarySize })
      } else {
        const s = firstPage.summary
        cliLog(ctx, `  Total: ${s.critical + s.high + s.medium + s.low}  Critical: ${s.critical}  High: ${s.high}  Medium: ${s.medium}  Low: ${s.low}`)
        if (firstPage.vulnerabilities.length === 0) {
          cliLog(ctx, '  No vulnerabilities found.')
        } else {
          for (const v of firstPage.vulnerabilities) {
            const fix = v.fixedIn ? ` → fix: ${v.fixedIn}` : ''
            const cvss = v.cvssScore != null ? ` (CVSS ${v.cvssScore})` : ''
            cliLog(ctx, `  [${v.severity.toUpperCase().padEnd(8)}] ${v.appName} ${v.installedVersion} — ${v.cveId}${cvss}${fix}`)
          }
          if (firstPage.nextPageUrl) {
            cliLog(ctx, `  ... and more (${firstPage.total} total). Use --json for full data.`)
          }
        }
      }
      if (firstPage.summary.critical > 0 || firstPage.summary.high > 0) return ExitCode.SCAN_THREATS
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      cliOut(ctx, ctx.json ? { error: msg } : `Failed: ${msg}`)
      return ExitCode.GENERAL_ERROR
    }
  } else {
    cliUsage(ctx, 'kudu --cli cve <list>')
    return ExitCode.INVALID_ARGS
  }
}

async function handleHistory(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { getHistory, clearHistory } = await import('./services/history-store')

  if (sub === 'list') {
    const history = getHistory()
    if (ctx.json) {
      cliOut(ctx, history)
    } else {
      if (history.length === 0) { cliLog(ctx, '  No scan history.'); return }
      for (const entry of history) {
        cliLog(ctx, `  [${entry.timestamp}] ${entry.type} — ${entry.totalItemsCleaned} items cleaned, ${formatBytes(entry.totalSpaceSaved)} saved`)
      }
    }
  } else if (sub === 'clear') {
    clearHistory()
    cliOut(ctx, ctx.json ? { message: 'History cleared' } : 'Scan history cleared.')
  } else {
    cliUsage(ctx, 'kudu --cli history <list|clear>')
    return ExitCode.INVALID_ARGS
  }
}

async function handleRestorePoint(args: string[], ctx: CliContext): Promise<number | void> {
  const { createRestorePoint } = await import('./services/restore-point')
  const description = args.slice(1).filter(a => !a.startsWith('--')).join(' ') || 'Kudu CLI restore point'

  if (args[0] === 'create') {
    cliLog(ctx, `Creating restore point: ${description}...`)
    const result = await createRestorePoint(description)
    cliOut(ctx, result)
  } else {
    cliUsage(ctx, 'kudu --cli restore-point create [description]')
    return ExitCode.INVALID_ARGS
  }
}

// ─── Config management ───────────────────────────────────────

async function handleConfig(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]
  const { getSettings, setSettings, flushSettings } = await import('./services/settings-store')

  if (sub === 'get') {
    const key = args[1]
    const settings = getSettings() as Record<string, any>
    if (!key) {
      cliOut(ctx, settings)
      return
    }
    // Support dotted paths like cloud.apiKey
    const value = key.split('.').reduce((obj: any, k: string) => obj?.[k], settings as any) as unknown
    if (value === undefined) {
      if (ctx.json) cliOut(ctx, { error: 'unknown_setting', key })
      else log(`Unknown setting: ${key}`)
      return ExitCode.INVALID_ARGS
    }
    // Mask the API key in non-JSON output
    if (key === 'cloud.apiKey' && !ctx.json && typeof value === 'string' && value.length > 8) {
      cliLog(ctx, `  ${key}: ${value.slice(0, 4)}...${value.slice(-4)}`)
    } else {
      cliOut(ctx, ctx.json ? { [key]: value } : `  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    }
  } else if (sub === 'set') {
    const key = args[1]
    const rawValue = args.slice(2).join(' ')
    if (!key || !rawValue) {
      if (ctx.json) {
        cliOut(ctx, { error: 'invalid_usage', usage: 'config set <key> <value>' })
      } else {
        cliLog(ctx, 'Usage: kudu --cli config set <key> <value>')
        cliLog(ctx, 'Example: kudu --cli config set cloud.apiKey your-key-here')
      }
      return ExitCode.INVALID_ARGS
    }
    // Parse the value — try JSON first, then treat as string
    let value: any = rawValue
    try {
      value = JSON.parse(rawValue)
    } catch {
      // Keep as string — handle common types
      if (rawValue === 'true') value = true
      else if (rawValue === 'false') value = false
      else if (/^\d+$/.test(rawValue)) value = parseInt(rawValue, 10)
    }
    // Build nested object from dotted path
    const parts = key.split('.')
    const obj: Record<string, any> = {}
    let cursor = obj
    for (let i = 0; i < parts.length - 1; i++) {
      cursor[parts[i]] = {}
      cursor = cursor[parts[i]]
    }
    cursor[parts[parts.length - 1]] = value
    setSettings(obj as any)
    await flushSettings()
    if (!ctx.json) cliLog(ctx, `  Set ${key} = ${typeof value === 'string' && key.includes('apiKey') ? '****' : value}`)
    else cliOut(ctx, { success: true, key, value: key.includes('apiKey') ? '****' : value })
  } else {
    if (ctx.json) {
      cliOut(ctx, { error: 'invalid_usage', usage: 'config <get|set> [key] [value]' })
    } else {
      cliLog(ctx, 'Usage: kudu --cli config <get|set> [key] [value]')
      cliLog(ctx, '')
      cliLog(ctx, 'Examples:')
      cliLog(ctx, '  kudu --cli config get                        Show all settings')
      cliLog(ctx, '  kudu --cli config get cloud.apiKey            Show API key')
      cliLog(ctx, '  kudu --cli config set cloud.apiKey my-key     Set API key')
    }
    return ExitCode.INVALID_ARGS
  }
}

// ─── Service management (systemd) ────────────────────────────

async function handleService(args: string[], ctx: CliContext): Promise<number | void> {
  const sub = args[0]

  if (process.platform !== 'linux') {
    if (ctx.json) {
      cliOut(ctx, { error: 'unsupported_platform', message: 'Service management is only supported on Linux (systemd)', platform: process.platform })
    } else {
      log('Error: Service management is only supported on Linux (systemd).')
      if (process.platform === 'win32') {
        log('On Windows, use Task Scheduler or NSSM to run as a service.')
      } else if (process.platform === 'darwin') {
        log('On macOS, use launchd with a plist file.')
      }
    }
    return ExitCode.INVALID_ARGS
  }

  const { writeFileSync, existsSync: fsExistsSync, unlinkSync } = await import('fs')
  const { execFileSync } = await import('child_process')

  const serviceName = 'kudu'
  const servicePath = `/etc/systemd/system/${serviceName}.service`
  const exePath = app.getPath('exe')

  // Determine the user to run as (prefer the user who invoked sudo)
  const runUser = process.env['SUDO_USER'] || process.env['USER'] || 'root'

  const unitContent = `[Unit]
Description=Kudu System Cleaner Daemon
Documentation=https://usekudu.com
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${runUser}
ExecStart=${exePath} --daemon
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=kudu
Environment=ELECTRON_NO_ATTACH_CONSOLE=1
Environment=DISPLAY=

[Install]
WantedBy=multi-user.target
`

  if (sub === 'install') {
    try {
      writeFileSync(servicePath, unitContent, 'utf-8')
      execFileSync('systemctl', ['daemon-reload'])
      if (ctx.json) {
        cliOut(ctx, { success: true, path: servicePath })
      } else {
        cliLog(ctx, `Service installed: ${servicePath}`)
        cliLog(ctx, '')
        cliLog(ctx, 'To start now:          sudo systemctl start kudu')
        cliLog(ctx, 'To enable on boot:     sudo systemctl enable kudu')
        cliLog(ctx, 'To do both:            sudo systemctl enable --now kudu')
        cliLog(ctx, 'To view logs:          journalctl -u kudu -f')
      }
    } catch (err: any) {
      if (err.message?.includes('EACCES') || err.message?.includes('Permission denied')) {
        if (ctx.json) cliOut(ctx, { error: 'permission_denied', message: 'Run with sudo' })
        else {
          log('Error: Permission denied. Run with sudo:')
          log('  sudo kudu --cli service install')
        }
        return ExitCode.PERMISSION_DENIED
      } else {
        if (ctx.json) cliOut(ctx, { error: 'install_failed', message: err.message })
        else log(`Error installing service: ${err.message}`)
        return ExitCode.GENERAL_ERROR
      }
    }
  } else if (sub === 'uninstall') {
    try {
      // Stop and disable first, ignore errors if not running
      try { execFileSync('systemctl', ['stop', serviceName]) } catch { /* ok */ }
      try { execFileSync('systemctl', ['disable', serviceName]) } catch { /* ok */ }
      if (fsExistsSync(servicePath)) {
        unlinkSync(servicePath)
        execFileSync('systemctl', ['daemon-reload'])
      }
      if (ctx.json) cliOut(ctx, { success: true })
      else cliLog(ctx, 'Service uninstalled.')
    } catch (err: any) {
      if (err.message?.includes('EACCES') || err.message?.includes('Permission denied')) {
        if (ctx.json) cliOut(ctx, { error: 'permission_denied', message: 'Run with sudo' })
        else {
          log('Error: Permission denied. Run with sudo:')
          log('  sudo kudu --cli service uninstall')
        }
        return ExitCode.PERMISSION_DENIED
      } else {
        if (ctx.json) cliOut(ctx, { error: 'uninstall_failed', message: err.message })
        else log(`Error uninstalling service: ${err.message}`)
        return ExitCode.GENERAL_ERROR
      }
    }
  } else if (sub === 'status') {
    try {
      if (ctx.json) {
        const output = execFileSync('systemctl', ['show', serviceName, '--property=ActiveState,SubState,LoadState,MainPID'], { encoding: 'utf-8' })
        const parsed = Object.fromEntries(output.trim().split('\n').map(l => l.split('=')))
        cliOut(ctx, parsed)
      } else {
        const output = execFileSync('systemctl', ['status', serviceName], { encoding: 'utf-8' })
        log(output)
      }
    } catch (err: any) {
      // systemctl status returns exit code 3 if service is not running
      if (ctx.json) {
        try {
          const output = execFileSync('systemctl', ['show', serviceName, '--property=ActiveState,SubState,LoadState,MainPID'], { encoding: 'utf-8' })
          const parsed = Object.fromEntries(output.trim().split('\n').map(l => l.split('=')))
          cliOut(ctx, parsed)
        } catch {
          cliOut(ctx, { error: 'not_installed', message: 'Service is not installed or not running' })
        }
      } else {
        if (err.stdout) log(err.stdout)
        else if (err.stderr) log(err.stderr)
        else cliLog(ctx, 'Service is not installed or not running.')
      }
    }
  } else {
    if (ctx.json) {
      cliOut(ctx, { error: 'invalid_usage', usage: 'service <install|uninstall|status>' })
    } else {
      cliLog(ctx, 'Usage: kudu --cli service <install|uninstall|status>')
      cliLog(ctx, '')
      cliLog(ctx, '  install     Install Kudu as a systemd service')
      cliLog(ctx, '  uninstall   Stop, disable, and remove the systemd service')
      cliLog(ctx, '  status      Show current service status')
    }
    return ExitCode.INVALID_ARGS
  }
}

// ─── Prometheus metrics ─────────────────────────────────────

async function handleMetrics(args: string[], ctx: CliContext): Promise<number | void> {
  const { collectMetrics, formatPrometheus } = await import('./services/metrics')
  const metrics = await collectMetrics()

  if (ctx.json) {
    cliOut(ctx, metrics)
  } else {
    log(formatPrometheus(metrics))
  }
}

async function handleMetricsServer(args: string[], ctx: CliContext): Promise<void> {
  const http = await import('http')
  const { collectMetrics, formatPrometheus } = await import('./services/metrics')

  const portIdx = args.indexOf('--port')
  const port = portIdx !== -1 ? (parseInt(args[portIdx + 1]) || 9100) : 9100

  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      try {
        const metrics = await collectMetrics()
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
        res.end(formatPrometheus(metrics))
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end(`Error collecting metrics: ${err.message}\n`)
      }
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
    } else {
      res.writeHead(404)
      res.end('Not Found\n')
    }
  })

  // Wait for the server to start or fail
  await new Promise<void>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use`))
      } else if (err.code === 'EACCES') {
        reject(new Error(`Permission denied for port ${port} (try a port >= 1024)`))
      } else {
        reject(err)
      }
    })
    server.listen(port, () => {
      cliLog(ctx, `Prometheus metrics server listening on http://0.0.0.0:${port}/metrics`)
      cliLog(ctx, 'Press Ctrl+C to stop.')
      resolve()
    })
  })

  const shutdown = (): void => {
    server.close()
    app.exit(ExitCode.SUCCESS)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // Keep alive — the HTTP server keeps the event loop running
  await new Promise(() => {})
}

// ─── Legacy file cleaner (backward compatible) ───────────────

async function runLegacyScanClean(categories: string[], doClean: boolean, ctx: CliContext): Promise<number> {
  const scannerMap: Record<string, () => Promise<ScanResult[]>> = {
    system: scanSystem,
    browser: scanBrowserCli,
    app: scanApp,
    gaming: scanGaming,
    'recycle-bin': scanRecycleBin,
    database: scanDatabaseCli,
  }

  const allResults: ScanResult[] = []
  const scanErrors: Array<{ category: string; error: string }> = []

  cliLog(ctx, `Kudu CLI v${app.getVersion()}`)
  cliLog(ctx, `Scanning: ${categories.join(', ')}`)
  cliLog(ctx, '')

  for (const cat of categories) {
    const scanner = scannerMap[cat]
    if (!scanner) continue
    cliLog(ctx, `Scanning ${cat}...`)
    const startTime = Date.now()
    try {
      const results = await scanner()
      allResults.push(...results)
      cliVerbose(ctx, `${cat} scan took ${Date.now() - startTime}ms, found ${results.length} groups`)
      if (showProgress(ctx)) {
        if (results.length === 0) log('  No items found.')
        else for (const r of results) log(`  ${r.subcategory}: ${r.itemCount} items, ${formatBytes(r.totalSize)}`)
        log('')
      }
    } catch (err: any) {
      scanErrors.push({ category: cat, error: err.message })
      cliLog(ctx, `  Error scanning ${cat}: ${err.message}`)
      cliLog(ctx, '')
    }
  }

  const totalItems = allResults.reduce((s, r) => s + r.itemCount, 0)
  const totalSize = allResults.reduce((s, r) => s + r.totalSize, 0)

  let cleanResult: CleanResult | null = null
  if (doClean && totalItems > 0) {
    cliLog(ctx, `Cleaning ${totalItems} items (${formatBytes(totalSize)})...`)
    const hasTrashPath = getPlatform().paths.trashPath() !== null
    // On macOS/Linux, trash items are real files scanned via scanDirectory — clean them with cleanItems
    // On Windows, recycle bin items are virtual (COM-based) and need special handling
    const fileItemIds = allResults
      .filter(r => r.category !== CleanerType.RecycleBin || hasTrashPath)
      .filter(r => r.category !== CleanerType.Database)
      .flatMap(r => r.items.map(i => i.id))
    const dbItemIds = allResults
      .filter(r => r.category === CleanerType.Database)
      .flatMap(r => r.items.map(i => i.id))
    const hasRecycleBin = !hasTrashPath && allResults.some(r => r.category === CleanerType.RecycleBin)
    let fileCleaned: CleanResult = { totalCleaned: 0, filesDeleted: 0, filesSkipped: 0, errors: [], needsElevation: false }
    let recycleCleaned: CleanResult = { totalCleaned: 0, filesDeleted: 0, filesSkipped: 0, errors: [], needsElevation: false }
    let dbCleaned: CleanResult = { totalCleaned: 0, filesDeleted: 0, filesSkipped: 0, errors: [], needsElevation: false }
    if (fileItemIds.length > 0) fileCleaned = await cleanItems(fileItemIds)
    if (hasRecycleBin) {
      const rbSize = allResults.find(r => r.category === CleanerType.RecycleBin)?.totalSize || 0
      recycleCleaned = await cleanRecycleBin(rbSize)
    }
    if (dbItemIds.length > 0) dbCleaned = await cleanDatabasesCli(dbItemIds)
    cleanResult = {
      totalCleaned: fileCleaned.totalCleaned + recycleCleaned.totalCleaned + dbCleaned.totalCleaned,
      filesDeleted: fileCleaned.filesDeleted + recycleCleaned.filesDeleted + dbCleaned.filesDeleted,
      filesSkipped: fileCleaned.filesSkipped + recycleCleaned.filesSkipped + dbCleaned.filesSkipped,
      errors: [...fileCleaned.errors, ...recycleCleaned.errors, ...dbCleaned.errors],
      needsElevation: fileCleaned.needsElevation || recycleCleaned.needsElevation || dbCleaned.needsElevation,
    }
    if (showProgress(ctx)) {
      log(`  Deleted: ${cleanResult.filesDeleted} items (${formatBytes(cleanResult.totalCleaned)})`)
      if (cleanResult.filesSkipped > 0) log(`  Skipped: ${cleanResult.filesSkipped} items`)
      if (cleanResult.errors.length > 0) {
        log(`  Errors: ${cleanResult.errors.length}`)
        for (const err of cleanResult.errors.slice(0, 10)) log(`    ${err.path}: ${err.reason}`)
        if (cleanResult.errors.length > 10) log(`    ... and ${cleanResult.errors.length - 10} more`)
      }
      log('')
    }
  }

  if (ctx.json) {
    const output: Record<string, unknown> = {
      scan: {
        categories,
        results: allResults.map(r => ({
          category: r.category, subcategory: r.subcategory, group: r.group || null,
          itemCount: r.itemCount, totalSize: r.totalSize,
          items: r.items.map(i => ({ path: i.path, size: i.size, lastModified: i.lastModified })),
        })),
        totalItems, totalSize,
        errors: scanErrors.length > 0 ? scanErrors : undefined,
      },
    }
    if (cleanResult) output.clean = cleanResult
    log(JSON.stringify(output, null, 2))
  } else {
    cliLog(ctx, '─'.repeat(50))
    cliLog(ctx, `Total: ${totalItems} items, ${formatBytes(totalSize)}`)
    if (cleanResult) cliLog(ctx, `Cleaned: ${formatBytes(cleanResult.totalCleaned)}`)
    else if (totalItems > 0) cliLog(ctx, 'Run with --clean to delete these items.')
  }

  // Determine exit code
  if (cleanResult?.errors.length) {
    if (cleanResult.needsElevation) return ExitCode.PERMISSION_DENIED
    if (cleanResult.filesDeleted > 0) return ExitCode.PARTIAL_SUCCESS
    return ExitCode.GENERAL_ERROR
  }
  if (totalItems === 0) return ExitCode.NOTHING_FOUND
  return ExitCode.SUCCESS
}

// ─── Main CLI entry point ────────────────────────────────────

export async function runCli(): Promise<void> {
  const parsed = parseCliArgs(process.argv)

  if (parsed.help) { printHelp(); app.exit(ExitCode.SUCCESS); return }
  if (parsed.version) { log(`Kudu v${app.getVersion()}`); app.exit(ExitCode.SUCCESS); return }

  const { ctx } = parsed

  // Validate mutually exclusive flags
  const cliArgs = process.argv.slice(process.argv.indexOf('--cli') + 1)
  if (cliArgs.includes('--verbose') && (cliArgs.includes('--quiet') || cliArgs.includes('-q'))) {
    if (ctx.json) log(JSON.stringify({ error: 'invalid_args', message: '--verbose and --quiet are mutually exclusive' }))
    else process.stderr.write('Error: --verbose and --quiet are mutually exclusive.\n')
    app.exit(ExitCode.INVALID_ARGS)
    return
  }

  // Legacy scan/clean mode — only enter when command is absent, 'scan', or 'clean'
  if (!parsed.command || parsed.command === 'scan' || parsed.command === 'clean') {
    const legacyCats = ['system', 'browser', 'app', 'gaming', 'recycle-bin']
    let categories: string[]
    if (cliArgs.includes('--all')) {
      categories = [...legacyCats]
    } else {
      categories = legacyCats.filter(c => cliArgs.includes(`--${c}`))
      if (categories.length === 0) categories = [...legacyCats]
    }
    const doClean = parsed.hasCleanFlag || parsed.command === 'clean'
    const exitCode = await runLegacyScanClean(categories, doClean, ctx)
    app.exit(exitCode)
    return
  }

  // Route to subcommand handlers
  try {
    let exitCode: number | void
    switch (parsed.command) {
      case 'registry': exitCode = await handleRegistry(parsed.commandArgs, ctx); break
      case 'startup': exitCode = await handleStartup(parsed.commandArgs, ctx); break
      case 'debloat': exitCode = await handleDebloat(parsed.commandArgs, ctx); break
      case 'disk': exitCode = await handleDisk(parsed.commandArgs, ctx); break
      case 'network': exitCode = await handleNetwork(parsed.commandArgs, ctx); break
      case 'malware': exitCode = await handleMalware(parsed.commandArgs, ctx); break
      case 'privacy': exitCode = await handlePrivacy(parsed.commandArgs, ctx); break
      case 'drivers': exitCode = await handleDrivers(parsed.commandArgs, ctx); break
      case 'services': exitCode = await handleServices(parsed.commandArgs, ctx); break
      case 'programs': exitCode = await handlePrograms(parsed.commandArgs, ctx); break
      case 'updates': exitCode = await handleUpdates(parsed.commandArgs, ctx); break
      case 'perf': exitCode = await handlePerf(parsed.commandArgs, ctx); break
      case 'leftovers': exitCode = await handleLeftovers(parsed.commandArgs, ctx); break
      case 'history': exitCode = await handleHistory(parsed.commandArgs, ctx); break
      case 'restore-point': exitCode = await handleRestorePoint(parsed.commandArgs, ctx); break
      case 'config': exitCode = await handleConfig(parsed.commandArgs, ctx); break
      case 'service': exitCode = await handleService(parsed.commandArgs, ctx); break
      case 'cve': exitCode = await handleCve(parsed.commandArgs, ctx); break
      case 'metrics': exitCode = await handleMetrics(parsed.commandArgs, ctx); break
      case 'metrics-server': await handleMetricsServer(parsed.commandArgs, ctx); return
      default:
        if (ctx.json) log(JSON.stringify({ error: 'unknown_command', command: parsed.command }))
        else {
          log(`Unknown command: ${parsed.command}`)
          log('Run kudu --cli --help for usage information.')
        }
        app.exit(ExitCode.UNKNOWN_COMMAND)
        return
    }
    app.exit(exitCode ?? ExitCode.SUCCESS)
  } catch (err: any) {
    if (ctx.json) {
      log(JSON.stringify({ error: err.message }))
    } else {
      process.stderr.write(`Error: ${err.message}\n`)
    }
    app.exit(ExitCode.GENERAL_ERROR)
  }
}
