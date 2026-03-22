import { readdir, stat } from 'fs/promises'
import { join, basename, extname } from 'path'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { createHash, randomUUID } from 'crypto'
import { getPlatform } from '../platform'
import { SAFE_FOLDER_NAMES, SAFE_PREFIXES } from '../constants/uninstall-safelist'
import { getDirectorySize } from './file-utils'
import type { InstalledProgram, ScanItem } from '../../shared/types'

const execFileAsync = promisify(execFile)

const REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

export function parseRegValue(block: string, name: string): string {
  // \b prevents matching substrings (e.g. "UninstallString" inside "QuietUninstallString")
  const match = block.match(new RegExp(`\\b${name}\\s+REG_SZ\\s+(.+)`, 'i'))
  return match ? match[1].trim() : ''
}

export function parseRegDword(block: string, name: string): number {
  const match = block.match(new RegExp(`\\b${name}\\s+REG_DWORD\\s+(0x[0-9a-fA-F]+)`, 'i'))
  return match ? parseInt(match[1], 16) : 0
}

export function extractRegistryKey(block: string): string {
  // First line of a block is the full registry key path
  const lines = block.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('HK')) return trimmed
  }
  return ''
}

function makeId(registryKey: string): string {
  return createHash('sha256').update(registryKey).digest('hex').substring(0, 16)
}

/**
 * Scan Windows Prefetch directory to build a map of exe name → last used timestamp.
 * Prefetch files are named like "PROGRAMNAME-HASH.pf" and their mtime = last execution.
 */
async function getPrefetchMap(): Promise<Map<string, number>> {
  const prefetchDir = join(process.env.WINDIR || 'C:\\Windows', 'Prefetch')
  const map = new Map<string, number>()

  try {
    const entries = await readdir(prefetchDir)
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.pf')) continue

      // Prefetch filename format: "EXENAME-HASH.pf" — extract the exe name
      const dashIdx = entry.lastIndexOf('-')
      if (dashIdx <= 0) continue
      const rawName = entry.substring(0, dashIdx).toLowerCase()
      // Strip .exe suffix so key matches getExeNames output (e.g. "chrome" not "chrome.exe")
      const exeName = rawName.endsWith('.exe') ? rawName.slice(0, -4) : rawName

      try {
        const s = await stat(join(prefetchDir, entry))
        const existing = map.get(exeName) || 0
        if (s.mtimeMs > existing) {
          map.set(exeName, s.mtimeMs)
        }
      } catch {
        // Skip inaccessible
      }
    }
  } catch {
    // Prefetch dir may not be accessible without admin
  }

  return map
}

/**
 * Extract likely executable names from a program's metadata for Prefetch matching.
 */
function getExeNames(program: InstalledProgram): string[] {
  const names: string[] = []

  // From DisplayIcon (often points to the main .exe)
  if (program.displayIcon) {
    let iconPath = program.displayIcon
    // Remove icon index suffix like ",0" or ",-1"
    iconPath = iconPath.replace(/,-?\d+$/, '').replace(/^"/, '').replace(/"$/, '')
    if (extname(iconPath).toLowerCase() === '.exe') {
      names.push(basename(iconPath, '.exe').toLowerCase())
    }
  }

  // From InstallLocation — look for .exe files in the folder name itself
  if (program.installLocation) {
    const folder = basename(program.installLocation).toLowerCase()
    if (folder.length >= 2) names.push(folder)
  }

  // From DisplayName — simplified (first word, common pattern)
  const nameLower = program.displayName.toLowerCase()
    .replace(/\s+[\d.]+\s*$/, '') // strip trailing version
    .trim()
  if (nameLower.length >= 3) {
    // Try the whole name as a single token (spaces→nothing, common for prefetch)
    names.push(nameLower.replace(/\s+/g, ''))
    // First word
    const first = nameLower.split(/[\s\-_.()]+/)[0]
    if (first && first.length >= 3) names.push(first)
  }

  return [...new Set(names)]
}

/**
 * Query the Windows Registry for all installed programs with full details.
 */
export async function getInstalledProgramsFull(): Promise<InstalledProgram[]> {
  // On non-Windows, use platform commands to list installed apps
  if (process.platform !== 'win32') {
    const platform = getPlatform()
    const apps = await platform.commands.getInstalledApps()
    return apps.map((app) => ({
      id: createHash('sha256').update(`${app.name}::${app.publisher}`).digest('hex').substring(0, 16),
      displayName: app.name,
      publisher: app.publisher,
      displayVersion: app.version,
      installDate: app.installDate || '',
      estimatedSize: (app.sizeKb || 0) * 1024,
      installLocation: '',
      uninstallString: '',
      quietUninstallString: '',
      displayIcon: '',
      registryKey: '',
      isSystemComponent: false,
      isWindowsInstaller: false,
      lastUsed: -1,
    })).sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  const programs: InstalledProgram[] = []
  const seen = new Set<string>() // dedup by displayName+publisher

  // Load prefetch data in parallel with registry queries
  const prefetchPromise = getPrefetchMap()

  for (const key of REGISTRY_KEYS) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/s'], {
        timeout: 20000,
        maxBuffer: 10 * 1024 * 1024,
      })

      const blocks = stdout.split(/\r?\n\r?\n/)
      for (const block of blocks) {
        const displayName = parseRegValue(block, 'DisplayName')
        if (!displayName) continue

        const uninstallString = parseRegValue(block, 'UninstallString')
        if (!uninstallString) continue

        const systemComponent = parseRegDword(block, 'SystemComponent')
        if (systemComponent === 1) continue

        const publisher = parseRegValue(block, 'Publisher')
        const dedupKey = `${displayName.toLowerCase()}|${publisher.toLowerCase()}`
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)

        const registryKey = extractRegistryKey(block)
        if (!registryKey) continue

        const estimatedSizeKB = parseRegDword(block, 'EstimatedSize')
        const windowsInstaller = parseRegDword(block, 'WindowsInstaller')

        programs.push({
          id: makeId(registryKey),
          displayName,
          publisher,
          displayVersion: parseRegValue(block, 'DisplayVersion'),
          installDate: parseRegValue(block, 'InstallDate'),
          estimatedSize: estimatedSizeKB * 1024,
          installLocation: parseRegValue(block, 'InstallLocation').replace(/\\$/, ''),
          uninstallString,
          quietUninstallString: parseRegValue(block, 'QuietUninstallString'),
          displayIcon: parseRegValue(block, 'DisplayIcon'),
          registryKey,
          isSystemComponent: false,
          isWindowsInstaller: windowsInstaller === 1,
          lastUsed: -1, // -1 = unknown, populated below from Prefetch if available
        })
      }
    } catch {
      // Registry key may not exist or access denied
    }
  }

  // Enrich with last-used timestamps from Prefetch
  const prefetchMap = await prefetchPromise
  if (prefetchMap.size > 0) {
    // Prefetch data is available — set lastUsed to 0 (not found) or actual timestamp
    for (const prog of programs) {
      const exeNames = getExeNames(prog)
      let bestTime = 0
      for (const name of exeNames) {
        // Try exact match first
        const exact = prefetchMap.get(name)
        if (exact && exact > bestTime) bestTime = exact

        // Try prefix match (e.g. "discord" matches "discordptb")
        for (const [pfKey, pfTime] of prefetchMap) {
          if (pfTime > bestTime && (pfKey.startsWith(name) || name.startsWith(pfKey))) {
            bestTime = pfTime
          }
        }
      }
      prog.lastUsed = bestTime
    }
  }
  // If prefetchMap is empty (e.g. no admin access), lastUsed stays -1 = unknown

  return programs.sort((a, b) => a.displayName.localeCompare(b.displayName))
}

/** Split an argument string respecting quoted segments (e.g. `/DIR="C:\Program Files\App"`) */
export function splitArgs(str: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuote = false
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '"') {
      inQuote = !inQuote
      current += ch
    } else if (/\s/.test(ch) && !inQuote) {
      if (current) { args.push(current); current = '' }
    } else {
      current += ch
    }
  }
  if (current) args.push(current)
  return args
}

/**
 * Parse an UninstallString into command and arguments.
 */
export function parseUninstallCommand(program: InstalledProgram): { command: string; args: string[] } {
  const raw = program.uninstallString.trim()

  // MSI-based: extract GUID and use msiexec
  if (program.isWindowsInstaller || raw.toLowerCase().includes('msiexec')) {
    const guidMatch = raw.match(/\{[0-9a-fA-F-]+\}/)
    if (guidMatch) {
      return { command: 'msiexec', args: ['/x', guidMatch[0]] }
    }
  }

  // Quoted path: "C:\path\to\uninstall.exe" args...
  if (raw.startsWith('"')) {
    const endQuote = raw.indexOf('"', 1)
    if (endQuote > 1) {
      const command = raw.substring(1, endQuote)
      const rest = raw.substring(endQuote + 1).trim()
      const args = rest ? splitArgs(rest) : []
      return { command, args }
    }
  }

  // Unquoted path: try to find .exe boundary
  const exeMatch = raw.match(/^(.+?\.exe)\s*(.*)/i)
  if (exeMatch) {
    const args = exeMatch[2] ? splitArgs(exeMatch[2].trim()) : []
    return { command: exeMatch[1], args }
  }

  // Fallback: treat whole string as command
  return { command: raw, args: [] }
}

/**
 * Run a program's native uninstaller and wait for it to exit.
 */
export function runUninstaller(program: InstalledProgram): Promise<number | null> {
  return new Promise((resolve) => {
    const { command, args } = parseUninstallCommand(program)

    try {
      const child = spawn(command, args, {
        detached: false,
        stdio: 'ignore',
        windowsHide: false,
      })

      const timeout = setTimeout(() => {
        try { child.kill() } catch { /* already exited */ }
        resolve(null)
      }, 10 * 60 * 1000) // 10 minute timeout

      child.on('close', (code) => {
        clearTimeout(timeout)
        resolve(code)
      })

      child.on('error', () => {
        clearTimeout(timeout)
        resolve(null)
      })
    } catch {
      resolve(null)
    }
  })
}

/**
 * Check if a program's registry key still exists after uninstall.
 */
export async function verifyUninstall(registryKey: string): Promise<boolean> {
  try {
    await execFileAsync('reg', ['query', registryKey], { timeout: 5000 })
    return false // key still exists = not fully uninstalled
  } catch {
    return true // key gone = uninstalled successfully
  }
}

// ─── Targeted leftover scanning ─────────────────────────────

export function isSafeFolder(folderName: string): boolean {
  const lower = folderName.toLowerCase()
  if (SAFE_FOLDER_NAMES.has(lower)) return true
  for (const prefix of SAFE_PREFIXES) {
    if (lower.startsWith(prefix)) return true
  }
  if (lower.startsWith('.')) return true
  if (/^\{[0-9a-f-]+\}$/i.test(folderName)) return true
  return false
}

export function folderMatchesProgram(folderName: string, program: InstalledProgram): boolean {
  const lower = folderName.toLowerCase()
  const nameTokens: string[] = []

  // Program name and its parts
  const name = program.displayName.toLowerCase()
  if (name.length >= 3) {
    nameTokens.push(name)
    const withoutVersion = name.replace(/\s+[\d.]+\s*$/, '').trim()
    if (withoutVersion.length >= 3 && withoutVersion !== name) nameTokens.push(withoutVersion)
    const firstWord = name.split(/[\s\-_.()]+/)[0]
    if (firstWord && firstWord.length >= 3) nameTokens.push(firstWord)
  }

  // Publisher
  const pub = program.publisher.toLowerCase()
  if (pub.length >= 3) {
    nameTokens.push(pub)
    const pubFirst = pub.split(/[\s\-_.()]+/)[0]
    if (pubFirst && pubFirst.length >= 3) nameTokens.push(pubFirst)
  }

  // Install location folder name
  if (program.installLocation) {
    const folder = basename(program.installLocation).toLowerCase()
    if (folder.length >= 2) nameTokens.push(folder)
  }

  for (const token of nameTokens) {
    if (token.length >= 4 && lower.length >= 4) {
      if (token.includes(lower) || lower.includes(token)) return true
    }
    if (token.length >= 4) {
      if (lower.startsWith(token) || lower.endsWith(token)) return true
    }
    if (lower.length >= 4) {
      if (token.startsWith(lower) || token.endsWith(lower)) return true
    }
  }

  return false
}

async function hasRunningProcesses(folderPaths: string[]): Promise<Set<string>> {
  const running = new Set<string>()
  if (folderPaths.length === 0) return running

  try {
    const procScript = 'Get-Process | Where-Object { $_.Path } | Select-Object -ExpandProperty Path -Unique'
    const procEncoded = Buffer.from(procScript, 'utf16le').toString('base64')
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-NoLogo', '-EncodedCommand', procEncoded,
    ], { timeout: 10000, windowsHide: true })

    const processPaths = stdout.split(/\r?\n/).map((p) => p.trim().toLowerCase()).filter(Boolean)

    for (const folderPath of folderPaths) {
      const folderLower = folderPath.toLowerCase().replace(/\//g, '\\')
      for (const procPath of processPaths) {
        if (procPath.startsWith(folderLower + '\\')) {
          running.add(folderPath)
          break
        }
      }
    }
  } catch {
    // If PowerShell fails, mark nothing as running
  }

  return running
}

/**
 * Scan for leftover files/folders after a specific program was uninstalled.
 */
export async function scanLeftoversForProgram(program: InstalledProgram): Promise<ScanItem[]> {
  const items: ScanItem[] = []

  // Check if the install location still exists
  if (program.installLocation) {
    try {
      const s = await stat(program.installLocation)
      if (s.isDirectory()) {
        const folderName = basename(program.installLocation)
        if (!isSafeFolder(folderName)) {
          const size = await getDirectorySize(program.installLocation, 3)
          if (size >= 1024) {
            items.push({
              id: randomUUID(),
              path: program.installLocation,
              size,
              category: 'uninstall-leftovers',
              subcategory: 'Install Location',
              lastModified: s.mtimeMs,
              selected: true,
            })
          }
        }
      }
    } catch {
      // Path doesn't exist — good
    }
  }

  // Scan common directories for matching folders
  for (const target of getPlatform().paths.uninstallLeftoverDirs()) {
    let entries: string[]
    try {
      entries = await readdir(target.path)
    } catch {
      continue
    }

    const candidates: { name: string; fullPath: string }[] = []
    for (const name of entries) {
      const fullPath = join(target.path, name)

      let entryStat: Awaited<ReturnType<typeof stat>>
      try {
        entryStat = await stat(fullPath)
      } catch {
        continue
      }
      if (!entryStat.isDirectory()) continue

      // Skip if it's the same as install location already added
      if (program.installLocation && fullPath.toLowerCase() === program.installLocation.toLowerCase()) continue

      if (isSafeFolder(name)) continue
      if (!folderMatchesProgram(name, program)) continue

      candidates.push({ name, fullPath })
    }

    if (candidates.length === 0) continue

    const runningFolders = await hasRunningProcesses(candidates.map((c) => c.fullPath))

    for (const candidate of candidates) {
      if (runningFolders.has(candidate.fullPath)) continue

      let size: number
      try {
        size = await getDirectorySize(candidate.fullPath, 2)
      } catch {
        continue
      }
      if (size < 1024) continue

      let folderStat: Awaited<ReturnType<typeof stat>>
      try {
        folderStat = await stat(candidate.fullPath)
      } catch {
        continue
      }

      items.push({
        id: randomUUID(),
        path: candidate.fullPath,
        size,
        category: 'uninstall-leftovers',
        subcategory: target.name,
        lastModified: folderStat.mtimeMs,
        selected: true,
      })

      if (items.length >= 50) break
    }
  }

  return items
}
