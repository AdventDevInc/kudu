import { lstat, readdir, readFile, writeFile, mkdir, rename } from 'fs/promises'
import { join, win32 } from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { IPC } from '../../shared/channels'
import type { WindowGetter } from '../ipc/index'
import { CleanerType } from '../../shared/enums'
import { getPlatform } from '../platform'
import { SAFE_FOLDER_NAMES, SAFE_PREFIXES } from '../constants/uninstall-safelist'
import { psUtf8, execTracked } from './exec-utf8'
import { CooperativeScheduler } from './cooperative-scheduler'
import type { ScanItem, ScanResult } from '../../shared/types'

interface InstalledProgram {
  displayName: string
  publisher: string
  installLocation: string
}

// Missing registry entries alone do not establish that an arbitrary folder is
// orphaned. Remember owners actually observed installed on this machine.
function parsePrograms(value: unknown): InstalledProgram[] {
  if (!Array.isArray(value)) throw new Error('Invalid installed-program inventory')
  return value.map((p: unknown) => {
    if (!p || typeof p !== 'object') throw new Error('Invalid installed-program entry')
    const entry = p as Record<string, unknown>
    for (const key of ['displayName', 'publisher', 'installLocation']) {
      if (typeof entry[key] !== 'string') throw new Error('Incomplete installed-program entry')
    }
    return entry as unknown as InstalledProgram
  })
}

async function getInstalledPrograms(): Promise<InstalledProgram[]> {
  // Test-Path distinguishes an absent optional hive from a failed query. Any
  // access/PowerShell/JSON failure aborts the scan, never an empty inventory.
  const script = `
    $ErrorActionPreference = 'Stop'
    $keys = @(
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKCU:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    )
    $programs = @(foreach ($key in $keys) {
      if (Test-Path -LiteralPath $key) {
        Get-ChildItem -LiteralPath $key | ForEach-Object {
          $p = Get-ItemProperty -LiteralPath $_.PSPath
          if ($p.DisplayName) {
            [PSCustomObject]@{
              displayName = [string]$p.DisplayName
              publisher = [string]$p.Publisher
              installLocation = [string]$p.InstallLocation
            }
          }
        }
      }
    })
    ConvertTo-Json -InputObject $programs -Compress
  `
  const { stdout } = await execTracked(
    'powershell',
    ['-NoProfile', '-NoLogo', '-Command', psUtf8(script)],
    {
      timeout: 30000,
      windowsHide: true
    }
  )
  const programs = parsePrograms(JSON.parse(stdout))
  if (programs.length === 0)
    throw new Error('Installed-program inventory is empty; refusing leftover scan')
  return programs
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

export function buildMatchTokens(programs: InstalledProgram[]): Set<string> {
  const tokens = new Set<string>()
  for (const p of programs) {
    for (const name of [
      p.displayName,
      p.publisher,
      win32.basename(p.installLocation.replace(/[\\/]+$/, ''))
    ]) {
      if (name.length >= 2) tokens.add(normalizeName(name))
      const first = name.split(/[\s\-_.()]+/)[0]
      if (first.length >= 3) tokens.add(normalizeName(first))
      const versionless = name.replace(/\s+[\d.]+\s*$/, '').trim()
      if (versionless.length >= 3) tokens.add(normalizeName(versionless))
    }
  }
  return tokens
}

export function matchesInstalledProgram(folderName: string, tokens: Set<string>): boolean {
  const name = normalizeName(folderName)
  return (
    tokens.has(name) ||
    [...tokens].some(
      (t) => t.length >= 4 && name.length >= 4 && (name.includes(t) || t.includes(name))
    )
  )
}

export function isSafeFolder(folderName: string): boolean {
  const lower = folderName.toLowerCase()
  return (
    SAFE_FOLDER_NAMES.has(lower) ||
    SAFE_PREFIXES.some((p) => lower.startsWith(p)) ||
    lower.startsWith('.') ||
    /^\{[0-9a-f-]+\}$/i.test(folderName)
  )
}

async function readPreviousOwners(programs: InstalledProgram[]): Promise<InstalledProgram[]> {
  const dir = app.isPackaged ? app.getPath('userData') : join(app.getPath('userData'), 'Kudu-Dev')
  const path = join(dir, 'leftover-owners.json')
  let previous: InstalledProgram[] = []
  try {
    previous = parsePrograms(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    // No usable history means no proven owners this time.
  }
  const owners = new Map(previous.map((p) => [JSON.stringify(p), p]))
  for (const p of programs) owners.set(JSON.stringify(p), p)
  await mkdir(dir, { recursive: true })
  const temp = path + '.' + randomUUID() + '.tmp'
  await writeFile(temp, JSON.stringify([...owners.values()].slice(-20000)), 'utf8')
  await rename(temp, path)
  return previous
}

async function isAbsent(path: string): Promise<boolean> {
  if (!win32.isAbsolute(path)) return false
  try {
    await lstat(path)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

// Only disposable children are eligible, never a whole profile, publisher or
// install directory. Even inside a cache, recognizable saves are protected.
const DISPOSABLE_DIRS = new Set(['cache', 'caches', 'code cache', 'gpucache', 'logs'])
const SAVE_FILE = /\.(?:sl2|lsv|lsf|save|sav|dat|bak)$/i
const MAX_ENTRIES = 10000
const MAX_DEPTH = 16

async function inspectDisposableTree(path: string, cutoff: number): Promise<number | null> {
  let remaining = MAX_ENTRIES
  const scheduler = new CooperativeScheduler()
  async function walk(current: string, depth: number): Promise<number | null> {
    await scheduler.yieldIfNeeded()
    if (--remaining < 0 || depth > MAX_DEPTH) return null
    const info = await lstat(current)
    if (info.isSymbolicLink() || info.mtimeMs > cutoff) return null
    if (info.isFile()) return SAVE_FILE.test(current) ? null : info.size
    if (!info.isDirectory()) return null
    let size = 0
    for (const entry of await readdir(current)) {
      const childSize = await walk(join(current, entry), depth + 1)
      if (childSize === null) return null
      size += childSize
    }
    return size
  }
  try {
    return await walk(path, 0)
  } catch {
    return null
  }
}

export async function scanForLeftovers(getWindow: WindowGetter): Promise<ScanResult[]> {
  if (process.platform !== 'win32') {
    throw new Error(
      'Standalone leftover scanning requires Windows installed-program ownership data'
    )
  }
  const category = CleanerType.UninstallLeftovers
  const send = (progress: number, currentPath: string, itemsFound = 0, sizeFound = 0) => {
    const win = getWindow()
    if (win && !win.isDestroyed())
      win.webContents.send(IPC.SCAN_PROGRESS, {
        phase: 'scanning',
        category,
        progress,
        currentPath,
        itemsFound,
        sizeFound
      })
  }
  send(5, 'Checking installed programs and running processes...')
  const programs = await getInstalledPrograms()
  const { stdout } = await execTracked(
    'powershell',
    [
      '-NoProfile',
      '-NoLogo',
      '-Command',
      psUtf8(
        "$ErrorActionPreference = 'Stop'; Get-Process | Where-Object { $_.Path } | Select-Object -ExpandProperty Path -Unique"
      )
    ],
    { timeout: 10000, windowsHide: true }
  )
  const processPaths = stdout
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!processPaths.length)
    throw new Error('Running-process inventory is empty; refusing leftover scan')
  const tokens = buildMatchTokens(programs)
  for (const path of processPaths) {
    for (const part of path.split(/[\\/]/).slice(0, -1)) tokens.add(normalizeName(part))
    tokens.add(normalizeName(win32.basename(path, win32.extname(path))))
  }
  const targets = getPlatform().paths.uninstallLeftoverDirs()
  // An installed/portable app may have no uninstall entry. Protect names seen
  // in either Program Files root, including data directories elsewhere.
  for (const target of targets.filter((t) => t.id.startsWith('programfiles'))) {
    try {
      if ((await lstat(target.path)).isSymbolicLink()) {
        throw new Error('Cannot verify installed applications through a linked Program Files root')
      }
      for (const entry of await readdir(target.path, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) tokens.add(normalizeName(entry.name))
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  const previous = await readPreviousOwners(programs)
  const absentOwners: InstalledProgram[] = []
  for (const owner of previous) {
    if (matchesInstalledProgram(owner.displayName, tokens)) continue
    if (await isAbsent(owner.installLocation)) absentOwners.push(owner)
  }
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  const results: ScanResult[] = []
  for (const target of targets.filter((t) => !t.id.startsWith('programfiles'))) {
    const items: ScanItem[] = []
    let entries: import('fs').Dirent<string>[]
    try {
      if ((await lstat(target.path)).isSymbolicLink()) continue
      entries = await readdir(target.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        isSafeFolder(entry.name) ||
        matchesInstalledProgram(entry.name, tokens)
      )
        continue
      // Positive ownership uses exact names, not the broad protective matcher.
      const name = normalizeName(entry.name)
      const owners = absentOwners.filter((p) =>
        [
          p.displayName.replace(/\s+[\d.]+\s*$/, ''),
          win32.basename(p.installLocation.replace(/[\\/]+$/, ''))
        ].some((n) => normalizeName(n) === name)
      )
      if (owners.length !== 1) continue
      const parent = join(target.path, entry.name)
      let children: import('fs').Dirent<string>[]
      try {
        const info = await lstat(parent)
        if (info.isSymbolicLink() || !info.isDirectory()) continue
        children = await readdir(parent, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (
          !child.isDirectory() ||
          child.isSymbolicLink() ||
          !DISPOSABLE_DIRS.has(child.name.toLowerCase())
        )
          continue
        const path = join(parent, child.name)
        const size = await inspectDisposableTree(path, cutoff)
        if (size === null || size < 1024) continue
        items.push({
          id: randomUUID(),
          path,
          size,
          category,
          subcategory: target.name,
          lastModified: (await lstat(path)).mtimeMs,
          recencyCutoff: cutoff,
          selected: false
        })
      }
      send(50, parent, results.reduce((n, r) => n + r.itemCount, 0) + items.length)
      if (items.length >= 100) break
    }
    if (items.length)
      results.push({
        category,
        subcategory: target.name,
        items,
        totalSize: items.reduce((n, i) => n + i.size, 0),
        itemCount: items.length
      })
  }
  send(
    100,
    'Leftover scan complete',
    results.reduce((n, r) => n + r.itemCount, 0),
    results.reduce((n, r) => n + r.totalSize, 0)
  )
  return results
}
