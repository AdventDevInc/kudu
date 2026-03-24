import { ipcMain } from 'electron'
import { existsSync, statSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { homedir } from 'os'
import { IPC } from '../../shared/channels'
import type { RegistryEntry } from '../../shared/types'
import { randomUUID } from 'crypto'
import type { WindowGetter } from './index'
import { validateStringArray } from '../services/ipc-validation'
import { execNativeUtf8, psUtf8 } from '../services/exec-utf8'

const execFileAsync = promisify(execFile)

/** Run reg.exe with UTF-8 code page so accented characters decode correctly */
async function execReg(args: string[], opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string }> {
  return execNativeUtf8('reg', args, opts)
}

/** Parse a CSV line handling escaped quotes ("") inside quoted fields */
function parseCSVLine(line: string): string[] {
  const fields: string[] = []
  let i = 0
  while (i < line.length) {
    if (line[i] === '"') {
      i++ // skip opening quote
      let field = ''
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            field += '"'
            i += 2
          } else {
            i++ // skip closing quote
            break
          }
        } else {
          field += line[i]
          i++
        }
      }
      fields.push(field)
      if (i < line.length && line[i] === ',') i++ // skip comma
    } else if (line[i] === ',') {
      fields.push('')
      i++
    } else {
      const next = line.indexOf(',', i)
      if (next === -1) {
        fields.push(line.substring(i))
        break
      }
      fields.push(line.substring(i, next))
      i = next + 1
    }
  }
  return fields
}

/** Validate that a task path contains only safe characters */
const SAFE_TASK_PATH_RE = /^[\\\p{L}\p{N}\s\-._()]+$/u

/** Split a full task path like "\\Folder\\Sub\\TaskName" into { path, name } for PowerShell */
function splitTaskPath(fullPath: string): { path: string; name: string } | null {
  const normalized = fullPath.replace(/\//g, '\\')
  if (!SAFE_TASK_PATH_RE.test(normalized)) return null
  const lastSlash = normalized.lastIndexOf('\\')
  if (lastSlash >= 0) {
    return {
      path: normalized.substring(0, lastSlash + 1),
      name: normalized.substring(lastSlash + 1)
    }
  }
  return { path: '\\', name: normalized }
}

// Session-scoped scan results keyed by scan ID to prevent race conditions
const scanSessions = new Map<string, Map<string, RegistryEntry>>()

/** Expand common Windows environment variables in a registry path. */
function expandEnvVars(path: string): string {
  return path
    .replace(/%SystemRoot%/gi, process.env.WINDIR || 'C:\\Windows')
    .replace(/%ProgramFiles%/gi, process.env.PROGRAMFILES || 'C:\\Program Files')
    .replace(/%ProgramFiles\(x86\)%/gi, process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)')
    .replace(/%ProgramData%/gi, process.env.PROGRAMDATA || 'C:\\ProgramData')
    .replace(/%CommonProgramFiles%/gi, process.env.COMMONPROGRAMFILES || 'C:\\Program Files\\Common Files')
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || '')
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || '')
    .replace(/%APPDATA%/gi, process.env.APPDATA || '')
}

/**
 * Extract the executable path from a command-line string, correctly
 * handling quoted paths with spaces and ignoring trailing arguments.
 *
 * For unquoted paths, uses the same algorithm as Windows CreateProcess:
 * progressively tries longer prefixes up to each space, checking if
 * the candidate path exists on disk. This correctly handles paths like
 * `C:\Program Files\App\svc.exe --background` where naive space-splitting
 * would return `C:\Program`.
 *
 * Examples:
 *   '"C:\\Program Files\\App\\svc.exe" --config foo.toml' → 'C:\\Program Files\\App\\svc.exe'
 *   'C:\\Program Files\\App\\svc.exe -k netsvcs'          → 'C:\\Program Files\\App\\svc.exe'
 *   'C:\\App\\svc.exe -k netsvcs'                         → 'C:\\App\\svc.exe'
 *   'rundll32.exe helper.dll,Entry'                       → 'rundll32.exe'
 */
function extractExePath(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Case 1: quoted path — extract content between first pair of quotes
  const quotedMatch = trimmed.match(/^"([^"]+)"/)
  if (quotedMatch) return quotedMatch[1].trim()
  // Case 2: no spaces — the whole string is the path
  if (!trimmed.includes(' ')) return trimmed
  // Build list of candidate split points: each space position, plus the
  // end of the string (the full string might be the path with no args).
  const splitPoints: number[] = []
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === ' ') splitPoints.push(i)
  }
  splitPoints.push(trimmed.length) // also try the full string
  // Case 3: try progressively longer prefixes, returning the first that
  // exists on disk as a FILE (not a directory). This is the Windows
  // CreateProcess algorithm for resolving ambiguous unquoted command lines.
  for (const pos of splitPoints) {
    const candidate = trimmed.substring(0, pos)
    if (candidate) {
      try {
        const s = statSync(candidate)
        if (s.isFile()) return candidate
      } catch { /* doesn't exist or inaccessible */ }
    }
  }
  // Case 4: no candidate exists on disk (the exe is missing). Find the
  // longest prefix that ends with a known executable extension.
  const exeExtRe = /\.(exe|dll|sys|cmd|bat|com|msc|cpl|scr)$/i
  for (let i = splitPoints.length - 1; i >= 0; i--) {
    const candidate = trimmed.substring(0, splitPoints[i])
    if (exeExtRe.test(candidate)) return candidate
  }
  // Case 5: no extension-bearing candidate — first token only.
  // Handles PATH-resolved commands like "rundll32.exe helper.dll,Entry"
  // where the exe name has no backslash path.
  return trimmed.substring(0, splitPoints[0])
}

/**
 * Check if a CLSID key exists in the registry, probing both the native
 * 64-bit view and the WOW6432Node (32-bit) view. On x64 Windows, 32-bit
 * COM servers register under the 32-bit hive, so a single-view lookup
 * produces false-positive "missing" results for valid 32-bit components.
 */
async function clsidExists(clsid: string): Promise<boolean> {
  // Try native view first
  try {
    await execReg(['query', `HKCR\\CLSID\\${clsid}`], { timeout: 5000 })
    return true
  } catch { /* not in native view */ }
  // Try 32-bit (WOW64) view
  try {
    await execReg([
      'query', `HKCR\\WOW6432Node\\CLSID\\${clsid}`
    ], { timeout: 5000 })
    return true
  } catch { /* not in WOW64 view either */ }
  return false
}

/**
 * Check if a CLSID's InprocServer32 DLL exists on disk (native view only).
 *
 * Returns:
 *   - The missing DLL path string if InprocServer32 exists but the DLL is gone
 *   - 'no-inproc' if InprocServer32 subkey is entirely missing (broken for
 *     in-process handlers — the caller should treat this as actionable)
 *   - null if the DLL exists on disk (healthy)
 */
async function findMissingClsidDll(clsid: string): Promise<string | 'no-inproc' | null> {
  // Check both native and WOW6432Node views for InprocServer32/LocalServer32.
  // Only report broken if NO view has a healthy DLL — a stale native entry
  // should not cause deletion when the WOW6432Node entry is healthy.
  const prefixes = [
    `HKCR\\CLSID\\${clsid}`,
    `HKCR\\WOW6432Node\\CLSID\\${clsid}`
  ]
  let foundAnyServer = false
  let firstMissingDll: string | null = null
  for (const prefix of prefixes) {
    // Check InprocServer32
    try {
      const { stdout } = await execReg([
        'query', `${prefix}\\InprocServer32`
      ], { timeout: 5000 })
      foundAnyServer = true
      const dllMatch = stdout.match(/\(Default\)\s+REG_SZ\s+(.+)/i)
      if (dllMatch) {
        const dllPath = dllMatch[1].trim().replace(/"/g, '')
        if (dllPath && dllPath.includes('\\') && !dllPath.startsWith('%')) {
          if (existsSync(dllPath)) return null // At least one view is healthy
          if (!firstMissingDll) firstMissingDll = dllPath
        }
      } else {
        return null // InprocServer32 exists but no parseable path — don't flag
      }
    } catch { /* No InprocServer32 in this view */ }
    // Check LocalServer32 as fallback
    try {
      await execReg([
        'query', `${prefix}\\LocalServer32`
      ], { timeout: 5000 })
      return null // Uses out-of-process server — healthy
    } catch { /* No LocalServer32 in this view either */ }
  }
  if (firstMissingDll) return firstMissingDll // All views with InprocServer32 have missing DLLs
  if (!foundAnyServer) return 'no-inproc' // No server registration at all
  return null
}

// ── Exported core logic ──

export async function scanRegistry(): Promise<RegistryEntry[]> {
    const entries: RegistryEntry[] = []

    // Scan for broken App Paths
    try {
      const { stdout } = await execReg([
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
        '/s'
      ], { timeout: 15000 })

      const blocks = stdout.split(/\r?\n\r?\n/)
      for (const block of blocks) {
        const keyMatch = block.match(/^(HKLM\\[^\r\n]+)/m)
        const valMatch = block.match(/\(Default\)\s+REG_SZ\s+(.+)/i)
        if (valMatch) {
          const exePath = valMatch[1].trim().replace(/"/g, '')
          if (exePath && !existsSync(exePath)) {
            entries.push({
              id: randomUUID(),
              type: 'invalid',
              keyPath: keyMatch?.[1] || 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
              valueName: '(Default)',
              issue: `App path points to missing file: ${exePath}`,
              risk: 'low',
              selected: true,
              fix: { op: 'delete-key' }
            })
          }
        }
      }
    } catch {
      // Skip if reg query fails
    }

    // Scan for broken SharedDLLs references
    try {
      const { stdout } = await execReg([
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs',
        '/s'
      ], { timeout: 15000 })

      const lines = stdout.split(/\r?\n/)
      for (const line of lines) {
        const match = line.match(/^\s+(.+?\.\w{2,4})\s+REG_DWORD\s+/i)
        if (match) {
          const dllPath = match[1].trim()
          if (dllPath && dllPath.length > 3 && !existsSync(dllPath)) {
            entries.push({
              id: randomUUID(),
              type: 'broken',
              keyPath: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs',
              valueName: dllPath,
              issue: `Shared DLL reference missing: ${dllPath}`,
              risk: 'low',
              selected: true,
              fix: { op: 'delete-value' }
            })
          }
        }
      }
    } catch {
      // Skip
    }

    // Scan for stale Run/RunOnce startup entries
    const runKeys = [
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce'
    ]
    for (const runKey of runKeys) {
      try {
        const { stdout } = await execReg(['query', runKey], { timeout: 10000 })
        const lines = stdout.split(/\r?\n/)
        for (const line of lines) {
          const match = line.match(/^\s+(\S+)\s+REG_SZ\s+(.+)/i)
          if (match) {
            const valueName = match[1].trim()
            const command = match[2].trim()
            const exePath = extractExePath(command)
            if (exePath) {
              if (exePath.includes('\\') && !existsSync(exePath)) {
                entries.push({
                  id: randomUUID(),
                  type: 'broken',
                  keyPath: runKey,
                  valueName,
                  issue: `Startup entry points to missing file: ${exePath}`,
                  risk: 'medium',
                  selected: true,
                  fix: { op: 'delete-value' }
                })
              }
            }
          }
        }
      } catch {
        // Skip
      }
    }

    // Scan for broken file associations
    try {
      const { stdout } = await execReg([
        'query',
        'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts',
        '/s'
      ], { timeout: 15000 })

      const blocks = stdout.split(/\r?\n\r?\n/)
      for (const block of blocks) {
        const keyMatch = block.match(/^(HKCU\\[^\r\n]+\\OpenWithList)/m)
        const appMatch = block.match(/REG_SZ\s+(.+\.exe)/i)
        if (keyMatch && appMatch) {
          const appName = appMatch[1].trim()
          try {
            await execReg([
              'query',
              `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${appName}`
            ], { timeout: 5000 })
          } catch {
            if (!appName.includes('\\') && !appName.includes('/')) {
              entries.push({
                id: randomUUID(),
                type: 'obsolete',
                keyPath: keyMatch[1],
                valueName: appName,
                issue: `File association references unregistered app: ${appName}`,
                risk: 'low',
                selected: true,
                fix: { op: 'delete-value' }
              })
            }
          }
        }
      }
    } catch {
      // Skip
    }

    // Scan for broken font references
    try {
      const { stdout } = await execReg([
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
        '/s'
      ], { timeout: 15000 })

      const winDir = process.env.WINDIR || 'C:\\Windows'
      const fontsDir = join(winDir, 'Fonts')
      const lines = stdout.split(/\r?\n/)
      for (const line of lines) {
        const match = line.match(/^\s+(.+?)\s+REG_SZ\s+(.+)/i)
        if (match) {
          const fontName = match[1].trim()
          let fontFile = match[2].trim()
          if (!fontFile.includes('\\') && !fontFile.includes('/')) {
            fontFile = join(fontsDir, fontFile)
          }
          if (fontFile && !existsSync(fontFile)) {
            entries.push({
              id: randomUUID(),
              type: 'invalid',
              keyPath: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
              valueName: fontName,
              issue: `Font file missing: ${fontFile}`,
              risk: 'low',
              selected: true,
              fix: { op: 'delete-value' }
            })
          }
        }
      }
    } catch {
      // Skip
    }

    // Scan for stale MUI Cache entries
    try {
      const { stdout } = await execReg([
        'query',
        'HKCU\\SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache',
        '/s'
      ], { timeout: 15000 })

      const muiKey = 'HKCU\\SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache'
      const lines = stdout.split(/\r?\n/)
      for (const line of lines) {
        const match = line.match(/^\s+(.+?\.exe(\.\w+))\s+REG_SZ\s+/i)
        if (match) {
          const fullValueName = match[1].trim()
          const exePath = fullValueName.replace(/\.\w+$/, '')
          if (exePath && exePath.includes('\\') && !existsSync(exePath)) {
            entries.push({
              id: randomUUID(),
              type: 'obsolete',
              keyPath: muiKey,
              valueName: fullValueName,
              issue: `MUI cache references uninstalled program: ${exePath}`,
              risk: 'low',
              selected: true,
              fix: { op: 'delete-value' }
            })
          }
        }
      }
    } catch {
      // Skip
    }

    // Scan for Windows Firewall rules pointing to missing programs
    try {
      const fwRulesKey = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\FirewallRules'
      const { stdout } = await execReg([
        'query', fwRulesKey, '/s'
      ], { timeout: 15000 })

      const lines = stdout.split(/\r?\n/)
      for (const line of lines) {
        const match = line.match(/REG_SZ\s+(.+)/i)
        if (match) {
          const ruleValue = match[1]
          const appMatch = ruleValue.match(/App=([^|]+)/i)
          if (appMatch) {
            const appPath = appMatch[1].trim()
            if (appPath && !appPath.startsWith('%') && appPath.includes('\\') && !existsSync(appPath)) {
              const nameMatch = line.match(/^\s+(.+?)\s+REG_SZ/i)
              entries.push({
                id: randomUUID(),
                type: 'obsolete',
                keyPath: fwRulesKey,
                valueName: nameMatch?.[1]?.trim() || 'Unknown Rule',
                issue: `Firewall rule for missing program: ${appPath}`,
                risk: 'low',
                selected: true,
                fix: { op: 'delete-value' }
              })
            }
          }
        }
      }
    } catch {
      // Skip
    }

    // Scan for broken context menu (shell) extensions
    const shellExtKeys = [
      'HKCR\\*\\shellex\\ContextMenuHandlers',
      'HKCR\\Directory\\shellex\\ContextMenuHandlers',
      'HKCR\\Folder\\shellex\\ContextMenuHandlers'
    ]
    for (const shellKey of shellExtKeys) {
      try {
        const { stdout } = await execReg(['query', shellKey, '/s'], { timeout: 10000 })
        const blocks = stdout.split(/\r?\n\r?\n/)
        for (const block of blocks) {
          const clsidMatch = block.match(/\(Default\)\s+REG_SZ\s+(\{[0-9A-Fa-f-]+\})/i)
          if (clsidMatch) {
            const clsid = clsidMatch[1]
            const keyMatch = block.match(/^(HK[^\r\n]+)/m)
            if (!await clsidExists(clsid)) {
              entries.push({
                id: randomUUID(),
                type: 'orphaned',
                keyPath: keyMatch?.[1]?.trim() || shellKey,
                valueName: clsid,
                issue: `Context menu handler references missing COM object: ${clsid}`,
                risk: 'low',
                selected: true,
                fix: { op: 'delete-key' }
              })
            } else {
              const missingDll = await findMissingClsidDll(clsid)
              if (missingDll) {
                entries.push({
                  id: randomUUID(),
                  type: 'broken',
                  keyPath: keyMatch?.[1]?.trim() || shellKey,
                  valueName: clsid,
                  issue: missingDll === 'no-inproc'
                    ? `Context menu handler has broken COM registration: ${clsid}`
                    : `Context menu handler DLL missing: ${missingDll}`,
                  risk: 'medium',
                  selected: true,
                  fix: { op: 'delete-key' }
                })
              }
            }
          }
        }
      } catch {
        // Skip
      }
    }

    // Scan for stale Windows Installer product references
    try {
      const installerKey = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Installer\\Folders'
      const { stdout } = await execReg([
        'query', installerKey, '/s'
      ], { timeout: 15000 })

      const lines = stdout.split(/\r?\n/)
      for (const line of lines) {
        const match = line.match(/^\s+(.+?)\s+REG_SZ/i)
        if (match) {
          const folderPath = match[1].trim()
          if (folderPath && folderPath.length > 3 && !existsSync(folderPath)) {
            entries.push({
              id: randomUUID(),
              type: 'orphaned',
              keyPath: installerKey,
              valueName: folderPath,
              issue: `Windows Installer references missing folder: ${folderPath}`,
              risk: 'low',
              selected: true,
              fix: { op: 'delete-value' }
            })
          }
        }
      }
    } catch {
      // Skip
    }

    // Scan for dead CLSID InprocServer32 entries
    try {
      const { stdout } = await execReg([
        'query', 'HKCR\\CLSID', '/s', '/f', 'InprocServer32', '/k'
      ], { timeout: 20000 })

      const blocks = stdout.split(/\r?\n\r?\n/)
      let comCount = 0
      for (const block of blocks) {
        if (comCount >= 50) break
        const keyMatch = block.match(/^(HKCR\\CLSID\\(\{[^}]+\})\\InprocServer32)/m)
        const dllMatch = block.match(/\(Default\)\s+REG_SZ\s+(.+)/i)
        if (keyMatch && dllMatch) {
          const dllPath = dllMatch[1].trim().replace(/"/g, '')
          if (dllPath && dllPath.includes('\\') && !dllPath.startsWith('%') && !existsSync(dllPath)) {
            const parentClsidKey = `HKCR\\CLSID\\${keyMatch[2]}`
            entries.push({
              id: randomUUID(),
              type: 'broken',
              keyPath: keyMatch[1],
              valueName: '(Default)',
              issue: `COM object DLL missing: ${dllPath}`,
              risk: 'medium',
              selected: true,
              fix: { op: 'delete-key', key: parentClsidKey }
            })
            comCount++
          }
        }
      }
    } catch {
      // Skip
    }

    // Scan for stale TypeLib entries
    try {
      const { stdout } = await execReg([
        'query', 'HKCR\\TypeLib', '/s', '/f', 'win32', '/k'
      ], { timeout: 15000 })

      const blocks = stdout.split(/\r?\n\r?\n/)
      let tlbCount = 0
      for (const block of blocks) {
        if (tlbCount >= 30) break
        const keyMatch = block.match(/^(HKCR\\TypeLib\\(\{[^}]+\})[^\r\n]*)/m)
        const valMatch = block.match(/\(Default\)\s+REG_SZ\s+(.+)/i)
        if (keyMatch && valMatch) {
          const tlbPath = valMatch[1].trim().replace(/"/g, '')
          if (tlbPath && tlbPath.includes('\\') && !tlbPath.startsWith('%') && !existsSync(tlbPath)) {
            const parentTypeLibKey = `HKCR\\TypeLib\\${keyMatch[2]}`
            entries.push({
              id: randomUUID(),
              type: 'orphaned',
              keyPath: keyMatch[1],
              valueName: '(Default)',
              issue: `Type library file missing: ${tlbPath}`,
              risk: 'low',
              selected: true,
              fix: { op: 'delete-key', key: parentTypeLibKey }
            })
            tlbCount++
          }
        }
      }
    } catch {
      // Skip
    }

    // Scan for orphaned App Compatibility shim entries (HKLM)
    try {
      const appCompatKeyLM = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'
      const { stdout } = await execReg([
        'query', appCompatKeyLM, '/s'
      ], { timeout: 10000 })

      const lines = stdout.split(/\r?\n/)
      for (const line of lines) {
        const match = line.match(/^\s+(.+?\.\w{2,4})\s+REG_SZ\s+/i)
        if (match) {
          const appPath = match[1].trim()
          if (appPath && appPath.includes('\\') && !existsSync(appPath)) {
            entries.push({
              id: randomUUID(),
              type: 'obsolete',
              keyPath: appCompatKeyLM,
              valueName: appPath,
              issue: `Compatibility shim for uninstalled app: ${appPath}`,
              risk: 'low',
              selected: true,
              fix: { op: 'delete-value' }
            })
          }
        }
      }
    } catch {
      // Skip
    }

    // Scan HKCU App Compat layers too
    try {
      const appCompatKeyCU = 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'
      const { stdout } = await execReg([
        'query', appCompatKeyCU, '/s'
      ], { timeout: 10000 })

      const lines = stdout.split(/\r?\n/)
      for (const line of lines) {
        const match = line.match(/^\s+(.+?\.\w{2,4})\s+REG_SZ\s+/i)
        if (match) {
          const appPath = match[1].trim()
          if (appPath && appPath.includes('\\') && !existsSync(appPath)) {
            entries.push({
              id: randomUUID(),
              type: 'obsolete',
              keyPath: appCompatKeyCU,
              valueName: appPath,
              issue: `Compatibility shim for uninstalled app: ${appPath}`,
              risk: 'low',
              selected: true,
              fix: { op: 'delete-value' }
            })
          }
        }
      }
    } catch {
      // Skip
    }

    // --- ORPHANED TRACES ---

    // Scan for orphaned services pointing to missing executables
    try {
      const servicesKey = 'HKLM\\SYSTEM\\CurrentControlSet\\Services'
      const { stdout } = await execReg([
        'query', servicesKey, '/s', '/f', 'ImagePath', '/v'
      ], { timeout: 20000 })

      const blocks = stdout.split(/\r?\n\r?\n/)
      let svcCount = 0
      for (const block of blocks) {
        if (svcCount >= 40) break
        // Extract the full key path from the block header
        const fullKeyMatch = block.match(/^(HK[^\r\n]+)/m)
        if (!fullKeyMatch) continue
        const fullKey = fullKeyMatch[1].trim()
        // Only process the service root key (exactly one level under Services\).
        // Skip child keys like Services\Foo\Parameters which may have their own
        // ImagePath values that don't represent the main service executable.
        // Count segments after "Services\" — should be exactly 1.
        const afterServices = fullKey.replace(/^.*\\Services\\/i, '')
        if (afterServices.includes('\\')) continue // deeper than one level
        const svcName = afterServices
        const valMatch = block.match(/ImagePath\s+REG_(?:EXPAND_)?SZ\s+(.+)/i)
        if (valMatch) {
          const rawImagePath = valMatch[1].trim()
          let imagePath = extractExePath(rawImagePath)
          if (!imagePath) continue
          // Expand common environment variables
          imagePath = expandEnvVars(imagePath)
          const lowerPath = imagePath.toLowerCase()
          // Skip system/Microsoft services and drivers
          if (lowerPath.startsWith('\\systemroot\\') ||
              lowerPath.startsWith('c:\\windows\\') ||
              lowerPath.includes('\\microsoft\\') ||
              lowerPath.includes('\\windows\\') ||
              imagePath.startsWith('\\??\\')) continue
          // Skip relative paths (e.g. "system32\drivers\foo.sys") and any
          // remaining unresolved env vars
          if (!imagePath.match(/^[A-Za-z]:\\/)) continue
          if (imagePath && !existsSync(imagePath)) {
            entries.push({
              id: randomUUID(),
              type: 'orphaned',
              keyPath: fullKey,
              valueName: 'ImagePath',
              issue: `Service "${svcName}" points to missing executable: ${imagePath}`,
              risk: 'medium',
              selected: true,
              fix: { op: 'delete-key' }
            })
            svcCount++
          }
        }
      }
    } catch {
      // Skip
    }

    // Scan for stale Programs & Features / Uninstall entries
    const uninstallKeys = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    ]
    for (const uninstallKey of uninstallKeys) {
      try {
        const { stdout } = await execReg([
          'query', uninstallKey, '/s'
        ], { timeout: 15000 })

        const blocks = stdout.split(/\r?\n\r?\n/)
        for (const block of blocks) {
          const keyMatch = block.match(/^(HK[^\r\n]+)/m)
          if (!keyMatch) continue
          const subKey = keyMatch[1]
          // Skip the parent key itself
          if (subKey === uninstallKey) continue
          // Look for InstallLocation or UninstallString
          const installLocMatch = block.match(/InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+)/i)
          const uninstallStrMatch = block.match(/UninstallString\s+REG_(?:EXPAND_)?SZ\s+(.+)/i)
          const displayNameMatch = block.match(/DisplayName\s+REG_(?:EXPAND_)?SZ\s+(.+)/i)
          // Skip entries without a display name (system components)
          if (!displayNameMatch) continue
          const displayName = displayNameMatch[1].trim()
          // Skip Microsoft/Windows entries
          if (displayName.startsWith('Microsoft') || displayName.startsWith('Windows') ||
              displayName.includes('Update for') || displayName.includes('Security Update') ||
              displayName.includes('Hotfix') || displayName.includes('KB')) continue

          // Check if the uninstall command still works — this is the primary signal.
          // A missing InstallLocation alone is not sufficient because MSI entries
          // (msiexec /x {GUID}) and rundll32-based uninstallers remain functional
          // even after the install folder is deleted.
          let uninstallBroken = false
          if (uninstallStrMatch) {
            const rawUninstall = uninstallStrMatch[1].trim()
            const exePath = expandEnvVars(extractExePath(rawUninstall) || '')
            if (exePath && exePath.toLowerCase().includes('msiexec')) {
              // MSI uninstallers are always functional (Windows Installer handles them)
            } else if (exePath && exePath.toLowerCase().includes('rundll32')) {
              // For rundll32 commands, check if the DLL argument exists.
              // Handle both quoted and unquoted forms:
              //   rundll32.exe C:\path\helper.dll,Entry
              //   "C:\Windows\System32\rundll32.exe" "C:\path\helper.dll",Entry
              //   rundll32.exe "C:\path\helper.dll",Entry
              const strippedUninstall = rawUninstall.replace(/"/g, '')
              const dllMatch = strippedUninstall.match(/rundll32(?:\.exe)?\s+([^,]+\.dll)/i)
              if (dllMatch) {
                const dllPath = expandEnvVars(dllMatch[1].trim())
                if (dllPath.includes('\\') && !dllPath.startsWith('%') && !existsSync(dllPath)) {
                  uninstallBroken = true
                }
              }
            } else if (exePath && exePath.includes('\\') && !exePath.startsWith('%') && !existsSync(exePath)) {
              uninstallBroken = true
            }
          }
          // A broken uninstaller alone doesn't mean the program is removed — many
          // installed programs have stale uninstaller paths after auto-updates.
          // Only flag as orphaned when we can confirm the program is actually gone:
          // the install directory must also be missing (or not set).
          let installDirExists = false
          if (installLocMatch) {
            const installLoc = expandEnvVars(installLocMatch[1].trim().replace(/"/g, ''))
            if (installLoc && installLoc.length > 3 && installLoc.includes('\\') && !installLoc.startsWith('%')) {
              installDirExists = existsSync(installLoc)
            }
          }
          // Also check DisplayIcon as a fallback — it typically points to the main exe
          if (!installDirExists) {
            const iconMatch = block.match(/DisplayIcon\s+REG_(?:EXPAND_)?SZ\s+(.+)/i)
            if (iconMatch) {
              const iconPath = expandEnvVars(iconMatch[1].trim().replace(/"/g, '').split(',')[0].trim())
              if (iconPath && iconPath.includes('\\') && !iconPath.startsWith('%') && existsSync(iconPath)) {
                installDirExists = true
              }
            }
          }

          let orphaned = false
          if (uninstallBroken && !installDirExists) {
            orphaned = true
          } else if (!uninstallStrMatch && !installDirExists && installLocMatch) {
            // No UninstallString and install location is gone
            orphaned = true
          }
          if (orphaned) {
            entries.push({
              id: randomUUID(),
              type: 'orphaned',
              keyPath: subKey,
              valueName: 'DisplayName',
              issue: `Uninstall entry for removed program: ${displayName}`,
              risk: 'low',
              selected: true,
              fix: { op: 'delete-key' }
            })
          }
        }
      } catch {
        // Skip
      }
    }

    // Scan for orphaned MIME content type handlers
    try {
      const mimeKey = 'HKCR\\MIME\\Database\\Content Type'
      const { stdout } = await execReg([
        'query', mimeKey, '/s'
      ], { timeout: 15000 })

      const blocks = stdout.split(/\r?\n\r?\n/)
      for (const block of blocks) {
        const keyMatch = block.match(/^(HKCR\\MIME\\Database\\Content Type\\[^\r\n]+)/m)
        const clsidMatch = block.match(/CLSID\s+REG_SZ\s+(\{[0-9A-Fa-f-]+\})/i)
        if (keyMatch && clsidMatch) {
          const clsid = clsidMatch[1]
          if (!await clsidExists(clsid)) {
            const mimeType = keyMatch[1].replace('HKCR\\MIME\\Database\\Content Type\\', '')
            entries.push({
              id: randomUUID(),
              type: 'orphaned',
              keyPath: keyMatch[1],
              valueName: 'CLSID',
              issue: `MIME type "${mimeType}" references missing handler: ${clsid}`,
              risk: 'low',
              selected: true,
              fix: { op: 'delete-value' }
            })
          }
        }
      }
    } catch {
      // Skip
    }

    // Scan for orphaned AutoPlay handler paths
    try {
      const autoPlayKey = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\AutoplayHandlers\\Handlers'
      const { stdout } = await execReg([
        'query', autoPlayKey, '/s'
      ], { timeout: 15000 })

      const blocks = stdout.split(/\r?\n\r?\n/)
      for (const block of blocks) {
        const keyMatch = block.match(/^(HKLM\\[^\r\n]+)/m)
        if (!keyMatch || keyMatch[1] === autoPlayKey) continue
        const progIdMatch = block.match(/ProgID\s+REG_SZ\s+(.+)/i)
        if (progIdMatch) {
          const progId = progIdMatch[1].trim()
          if (progId) {
            try {
              await execReg(['query', `HKCR\\${progId}`], { timeout: 5000 })
            } catch {
              const handlerName = keyMatch[1].split('\\').pop() || 'Unknown'
              entries.push({
                id: randomUUID(),
                type: 'orphaned',
                keyPath: keyMatch[1],
                valueName: 'ProgID',
                issue: `AutoPlay handler "${handlerName}" references missing ProgID: ${progId}`,
                risk: 'low',
                selected: true,
                fix: { op: 'delete-key' }
              })
            }
          }
        }
      }
    } catch {
      // Skip
    }

    // --- ORPHANED REGISTERED CLIENTS ---

    // Scan for orphaned registered client applications (browsers, email, media)
    const clientLabels = [
      { subKey: 'StartMenuInternet', label: 'web browser' },
      { subKey: 'Mail', label: 'email client' },
      { subKey: 'Media', label: 'media player' },
      { subKey: 'News', label: 'news reader' },
      { subKey: 'Calendar', label: 'calendar app' }
    ]
    const clientRoots = [
      'HKLM\\SOFTWARE\\Clients',
      'HKLM\\SOFTWARE\\WOW6432Node\\Clients',
      'HKCU\\SOFTWARE\\Clients'
    ]
    const clientCategories: { key: string; label: string }[] = []
    for (const root of clientRoots) {
      for (const { subKey, label } of clientLabels) {
        clientCategories.push({ key: `${root}\\${subKey}`, label })
      }
    }
    for (const client of clientCategories) {
      try {
        const { stdout } = await execReg([
          'query', client.key
        ], { timeout: 10000 })

        const lines = stdout.split(/\r?\n/)
        for (const line of lines) {
          const subKeyMatch = line.match(/^(HK\w+\\SOFTWARE\\(?:WOW6432Node\\)?Clients\\[^\\]+\\(.+))$/m)
          if (!subKeyMatch) continue
          const subKey = subKeyMatch[1].trim()
          const clientName = subKeyMatch[2].trim()
          // Skip Windows built-in clients
          if (clientName.toLowerCase().includes('microsoft') ||
              clientName.toLowerCase().includes('windows') ||
              clientName.toLowerCase() === 'outlook') continue
          // Check if the client has a shell/open/command with a valid exe
          try {
            const { stdout: cmdOut } = await execReg([
              'query', `${subKey}\\shell\\open\\command`
            ], { timeout: 5000 })
            const rawValMatch = cmdOut.match(/\(Default\)\s+REG_SZ\s+(.+)/i)
            const exePath = rawValMatch ? extractExePath(rawValMatch[1].trim()) : null
            if (exePath && exePath.includes('\\') && !exePath.startsWith('%') && !existsSync(exePath)) {
              entries.push({
                id: randomUUID(),
                type: 'orphaned',
                keyPath: subKey,
                valueName: 'shell\\open\\command',
                issue: `Registered ${client.label} "${clientName}" points to missing executable: ${exePath}`,
                risk: 'low',
                selected: true,
                fix: { op: 'delete-key' }
              })
            }
          } catch {
            // No shell command — check if LocalServer32/InstallInfo exists instead
          }
        }
      } catch {
        // Skip
      }
    }

    // Scan for orphaned Browser Helper Objects (BHOs) in both native and WOW6432Node hives
    const bhoKeys = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Browser Helper Objects',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Browser Helper Objects'
    ]
    for (const bhoKey of bhoKeys) {
      try {
        const { stdout } = await execReg([
          'query', bhoKey
        ], { timeout: 10000 })

        const lines = stdout.split(/\r?\n/)
        for (const line of lines) {
          const subKeyMatch = line.match(/^(HKLM\\[^\\]+.*\\(\{[0-9A-Fa-f-]+\}))$/m)
          if (!subKeyMatch) continue
          const bhoSubKey = subKeyMatch[1].trim()
          const clsid = subKeyMatch[2]
          if (!await clsidExists(clsid)) {
            entries.push({
              id: randomUUID(),
              type: 'orphaned',
              keyPath: bhoSubKey,
              valueName: clsid,
              issue: `Browser Helper Object references missing COM object: ${clsid}`,
              risk: 'low',
              selected: true,
              fix: { op: 'delete-key' }
            })
          } else {
            const missingDll = await findMissingClsidDll(clsid)
            if (missingDll) {
              entries.push({
                id: randomUUID(),
                type: 'orphaned',
                keyPath: bhoSubKey,
                valueName: clsid,
                issue: missingDll === 'no-inproc'
                  ? `Browser Helper Object has broken COM registration: ${clsid}`
                  : `Browser Helper Object DLL missing: ${missingDll}`,
                risk: 'low',
                selected: true,
                fix: { op: 'delete-key' }
              })
            }
          }
        }
      } catch {
        // Skip — key may not exist
      }
    }

    // Scan for orphaned Event Log application sources
    try {
      const eventLogKey = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application'
      const { stdout } = await execReg([
        'query', eventLogKey
      ], { timeout: 10000 })

      const lines = stdout.split(/\r?\n/)
      for (const line of lines) {
        const subKeyMatch = line.match(/^(HKLM\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\(.+))$/m)
        if (!subKeyMatch) continue
        const sourceKey = subKeyMatch[1].trim()
        const sourceName = subKeyMatch[2].trim()
        // Skip system/Microsoft event sources
        if (sourceName.toLowerCase().startsWith('microsoft') ||
            sourceName.toLowerCase().startsWith('windows') ||
            sourceName.toLowerCase().startsWith('.net') ||
            sourceName.toLowerCase() === 'application' ||
            sourceName.toLowerCase() === 'application error' ||
            sourceName.toLowerCase() === 'application hang' ||
            sourceName.toLowerCase() === 'eventlog' ||
            sourceName.toLowerCase() === 'vssetup') continue
        try {
          const { stdout: srcOut } = await execReg([
            'query', sourceKey, '/v', 'EventMessageFile'
          ], { timeout: 5000 })
          const pathMatch = srcOut.match(/EventMessageFile\s+REG_(?:EXPAND_)?SZ\s+(.+)/i)
          if (pathMatch) {
            const rawValue = pathMatch[1].trim().replace(/"/g, '')
            const winDir = process.env.WINDIR || 'C:\\Windows'
            // Split on both semicolons and commas (both are valid delimiters)
            const allPaths = rawValue.split(/[;,]/)
              .map(p => p.trim())
              .filter(p => p.length > 0)
              .map(p => p.replace(/%SystemRoot%/i, winDir))
            // Skip if any path uses env vars we can't resolve
            if (allPaths.some(p => p.startsWith('%'))) continue
            // Only flag as orphaned if EVERY message file is missing
            const checkable = allPaths.filter(p => p.includes('\\'))
            if (checkable.length > 0 && checkable.every(p => !existsSync(p))) {
              // Check if the source has a PrimaryModule fallback — if so, it can
              // still resolve event descriptions without its own message files
              let hasPrimaryModule = false
              try {
                const { stdout: pmOut } = await execReg([
                  'query', sourceKey, '/v', 'PrimaryModule'
                ], { timeout: 3000 })
                if (pmOut.includes('PrimaryModule')) hasPrimaryModule = true
              } catch { /* no PrimaryModule — safe to flag */ }
              if (!hasPrimaryModule) {
                entries.push({
                  id: randomUUID(),
                  type: 'orphaned',
                  keyPath: sourceKey,
                  valueName: 'EventMessageFile',
                  issue: `Event log source "${sourceName}" — all message files missing`,
                  risk: 'low',
                  selected: true,
                  fix: { op: 'delete-key' }
                })
              }
            }
          }
        } catch {
          // No EventMessageFile value — not necessarily orphaned
        }
      }
    } catch {
      // Skip
    }

    // Scan for orphaned COM Interface proxy stubs
    try {
      const { stdout } = await execReg([
        'query', 'HKCR\\Interface', '/s', '/f', 'ProxyStubClsid32'
      ], { timeout: 20000 })

      const blocks = stdout.split(/\r?\n\r?\n/)
      let ifaceCount = 0
      for (const block of blocks) {
        if (ifaceCount >= 30) break
        const keyMatch = block.match(/^(HKCR\\Interface\\(\{[^}]+\})\\ProxyStubClsid32)/m)
        const valMatch = block.match(/\(Default\)\s+REG_SZ\s+(\{[0-9A-Fa-f-]+\})/i)
        if (keyMatch && valMatch) {
          const proxyClsid = valMatch[1]
          // Skip well-known system proxy stubs (OLE/COM standard marshaler)
          if (proxyClsid === '{00000320-0000-0000-C000-000000000046}' ||
              proxyClsid === '{0000033A-0000-0000-C000-000000000046}') continue
          if (!await clsidExists(proxyClsid)) {
            const parentIfaceKey = `HKCR\\Interface\\${keyMatch[2]}`
            entries.push({
              id: randomUUID(),
              type: 'orphaned',
              keyPath: keyMatch[1],
              valueName: proxyClsid,
              issue: `COM interface references missing proxy stub: ${proxyClsid}`,
              risk: 'medium',
              selected: true,
              fix: { op: 'delete-key', key: parentIfaceKey }
            })
            ifaceCount++
          } else {
            // CLSID exists in at least one view — check if its DLL is present
            const missingDll = await findMissingClsidDll(proxyClsid)
            if (missingDll) {
              const parentIfaceKey = `HKCR\\Interface\\${keyMatch[2]}`
              entries.push({
                id: randomUUID(),
                type: 'orphaned',
                keyPath: keyMatch[1],
                valueName: proxyClsid,
                issue: missingDll === 'no-inproc'
                  ? `COM interface proxy stub has broken registration: ${proxyClsid}`
                  : `COM interface proxy stub DLL missing: ${missingDll}`,
                risk: 'medium',
                selected: true,
                fix: { op: 'delete-key', key: parentIfaceKey }
              })
              ifaceCount++
            }
          }
        }
      }
    } catch {
      // Skip
    }

    // Scan for orphaned UserChoice file associations (default app for removed programs)
    try {
      const fileExtsKey = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts'
      const { stdout } = await execReg([
        'query', fileExtsKey, '/s', '/f', 'UserChoice'
      ], { timeout: 15000 })

      const blocks = stdout.split(/\r?\n\r?\n/)
      for (const block of blocks) {
        const keyMatch = block.match(/^(HKCU\\[^\r\n]*\\UserChoice)/m)
        const progIdMatch = block.match(/ProgId\s+REG_SZ\s+(.+)/i)
        if (keyMatch && progIdMatch) {
          const progId = progIdMatch[1].trim()
          // Skip system/built-in ProgIDs
          if (!progId || progId.startsWith('AppX') || progId.startsWith('Microsoft.') ||
              progId.startsWith('Windows.') || progId === 'Applications' ||
              progId.startsWith('IE.') || progId.startsWith('MSEdge') ||
              progId.startsWith('Acrobat') || progId.startsWith('WMP')) continue
          // Check if the ProgID still exists in HKCR
          try {
            await execReg(['query', `HKCR\\${progId}`], { timeout: 3000 })
          } catch {
            const extMatch = keyMatch[1].match(/FileExts\\([^\\]+)\\UserChoice/)
            const ext = extMatch ? extMatch[1] : 'unknown'
            entries.push({
              id: randomUUID(),
              type: 'orphaned',
              keyPath: keyMatch[1],
              valueName: 'ProgId',
              issue: `Default app for "${ext}" references removed program: ${progId}`,
              risk: 'low',
              selected: true,
              fix: { op: 'delete-key' }
            })
          }
        }
      }
    } catch {
      // Skip
    }

    // --- SECURITY VULNERABILITY SCANS ---
    // Security hardening checks

    // Check if UAC is disabled
    try {
      const { stdout } = await execReg([
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System',
        '/v', 'EnableLUA'
      ], { timeout: 5000 })
      const match = stdout.match(/EnableLUA\s+REG_DWORD\s+0x(\d+)/i)
      if (match && match[1] === '0') {
        entries.push({
          id: randomUUID(),
          type: 'vulnerability',
          keyPath: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System',
          valueName: 'EnableLUA',
          issue: 'User Account Control (UAC) is disabled — malware can run with admin privileges silently',
          risk: 'high',
          selected: true,
          fix: { op: 'set-value', regType: 'REG_DWORD', data: '1' }
        })
      }
    } catch {
      // Skip
    }

    // Check if Windows Defender real-time protection is disabled
    try {
      const { stdout } = await execReg([
        'query',
        'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection',
        '/v', 'DisableRealtimeMonitoring'
      ], { timeout: 5000 })
      const match = stdout.match(/DisableRealtimeMonitoring\s+REG_DWORD\s+0x(\d+)/i)
      if (match && match[1] === '1') {
        entries.push({
          id: randomUUID(),
          type: 'vulnerability',
          keyPath: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection',
          valueName: 'DisableRealtimeMonitoring',
          issue: 'Windows Defender real-time protection is disabled via policy',
          risk: 'high',
          selected: true,
          fix: { op: 'delete-value' }
        })
      }
    } catch {
      // Key doesn't exist = not disabled, which is fine
    }

    // Check if Windows Defender is fully disabled
    try {
      const { stdout } = await execReg([
        'query',
        'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender',
        '/v', 'DisableAntiSpyware'
      ], { timeout: 5000 })
      const match = stdout.match(/DisableAntiSpyware\s+REG_DWORD\s+0x(\d+)/i)
      if (match && match[1] === '1') {
        entries.push({
          id: randomUUID(),
          type: 'vulnerability',
          keyPath: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender',
          valueName: 'DisableAntiSpyware',
          issue: 'Windows Defender antivirus is completely disabled via policy',
          risk: 'high',
          selected: true,
          fix: { op: 'delete-value' }
        })
      }
    } catch {
      // Skip
    }

    // Check if AutoRun is enabled
    try {
      const { stdout } = await execReg([
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer',
        '/v', 'NoDriveTypeAutoRun'
      ], { timeout: 5000 })
      const match = stdout.match(/NoDriveTypeAutoRun\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i)
      if (!match || parseInt(match[1], 16) < 0xff) {
        entries.push({
          id: randomUUID(),
          type: 'vulnerability',
          keyPath: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer',
          valueName: 'NoDriveTypeAutoRun',
          issue: 'AutoRun is not fully disabled — removable drives can auto-execute malware',
          risk: 'medium',
          selected: true,
          fix: { op: 'set-value', regType: 'REG_DWORD', data: '255' }
        })
      }
    } catch {
      entries.push({
        id: randomUUID(),
        type: 'vulnerability',
        keyPath: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer',
        valueName: 'NoDriveTypeAutoRun',
        issue: 'AutoRun is not disabled — removable drives can auto-execute malware',
        risk: 'medium',
        selected: true,
        fix: { op: 'set-value', regType: 'REG_DWORD', data: '255' }
      })
    }

    // Check if SMBv1 is enabled
    try {
      const { stdout } = await execReg([
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Services\\LanmanServer\\Parameters',
        '/v', 'SMB1'
      ], { timeout: 5000 })
      const match = stdout.match(/SMB1\s+REG_DWORD\s+0x(\d+)/i)
      if (match && match[1] !== '0') {
        entries.push({
          id: randomUUID(),
          type: 'vulnerability',
          keyPath: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\LanmanServer\\Parameters',
          valueName: 'SMB1',
          issue: 'SMBv1 protocol is enabled — vulnerable to WannaCry and EternalBlue exploits',
          risk: 'high',
          selected: true,
          fix: { op: 'set-value', regType: 'REG_DWORD', data: '0' }
        })
      }
    } catch {
      // Key missing — SMBv1 may still be enabled via feature
    }

    // Check if Remote Desktop is enabled without NLA
    try {
      const { stdout: rdpEnabled } = await execReg([
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server',
        '/v', 'fDenyTSConnections'
      ], { timeout: 5000 })
      const rdpMatch = rdpEnabled.match(/fDenyTSConnections\s+REG_DWORD\s+0x(\d+)/i)
      if (rdpMatch && rdpMatch[1] === '0') {
        try {
          const rdpNlaKey = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp'
          const { stdout: nlaOut } = await execReg([
            'query', rdpNlaKey, '/v', 'UserAuthentication'
          ], { timeout: 5000 })
          const nlaMatch = nlaOut.match(/UserAuthentication\s+REG_DWORD\s+0x(\d+)/i)
          if (!nlaMatch || nlaMatch[1] === '0') {
            entries.push({
              id: randomUUID(),
              type: 'vulnerability',
              keyPath: rdpNlaKey,
              valueName: 'UserAuthentication',
              issue: 'Remote Desktop is enabled without Network Level Authentication (NLA)',
              risk: 'high',
              selected: true,
              fix: { op: 'set-value', regType: 'REG_DWORD', data: '1' }
            })
          }
        } catch {
          // Skip
        }
      }
    } catch {
      // Skip
    }

    // Check if PowerShell execution policy is unrestricted
    try {
      const { stdout } = await execReg([
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell',
        '/v', 'ExecutionPolicy'
      ], { timeout: 5000 })
      const match = stdout.match(/ExecutionPolicy\s+REG_SZ\s+(.+)/i)
      if (match) {
        const policy = match[1].trim().toLowerCase()
        if (policy === 'unrestricted' || policy === 'bypass') {
          entries.push({
            id: randomUUID(),
            type: 'vulnerability',
            keyPath: 'HKLM\\SOFTWARE\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell',
            valueName: 'ExecutionPolicy',
            issue: `PowerShell execution policy is "${match[1].trim()}" — scripts from any source can run`,
            risk: 'medium',
            selected: true,
            fix: { op: 'set-value', regType: 'REG_SZ', data: 'RemoteSigned' }
          })
        }
      }
    } catch {
      // Skip
    }

    // Check if Windows Firewall is disabled
    const fwProfiles = [
      { key: 'DomainProfile', label: 'Domain' },
      { key: 'StandardProfile', label: 'Private' },
      { key: 'PublicProfile', label: 'Public' }
    ]
    for (const profile of fwProfiles) {
      try {
        const fwKey = `HKLM\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\${profile.key}`
        const { stdout } = await execReg([
          'query', fwKey, '/v', 'EnableFirewall'
        ], { timeout: 5000 })
        const match = stdout.match(/EnableFirewall\s+REG_DWORD\s+0x(\d+)/i)
        if (match && match[1] === '0') {
          entries.push({
            id: randomUUID(),
            type: 'vulnerability',
            keyPath: fwKey,
            valueName: 'EnableFirewall',
            issue: `Windows Firewall is disabled for ${profile.label} network profile`,
            risk: 'high',
            selected: true,
            fix: { op: 'set-value', regType: 'REG_DWORD', data: '1' }
          })
        }
      } catch {
        // Skip
      }
    }

    // Check if Remote Registry service is enabled
    try {
      const { stdout } = await execReg([
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Services\\RemoteRegistry',
        '/v', 'Start'
      ], { timeout: 5000 })
      const match = stdout.match(/Start\s+REG_DWORD\s+0x(\d+)/i)
      if (match && (match[1] === '2' || match[1] === '3')) {
        entries.push({
          id: randomUUID(),
          type: 'vulnerability',
          keyPath: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\RemoteRegistry',
          valueName: 'Start',
          issue: `Remote Registry service is ${match[1] === '2' ? 'set to auto-start' : 'enabled'} — allows remote registry access`,
          risk: 'medium',
          selected: true,
          fix: { op: 'set-value', regType: 'REG_DWORD', data: '4' }
        })
      }
    } catch {
      // Skip
    }

    // --- PERFORMANCE TWEAKS ---

    // Check if SysMain (Superfetch) is enabled — only recommend disabling on SSDs
    try {
      const { stdout } = await execReg([
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Services\\SysMain',
        '/v', 'Start'
      ], { timeout: 5000 })
      const match = stdout.match(/Start\s+REG_DWORD\s+0x(\d+)/i)
      if (match && (match[1] === '2' || match[1] === '3')) {
        // Detect if the system drive is an SSD
        let isSSD = false
        try {
          const diskScript = `$disk = Get-PhysicalDisk | Where-Object { $_.DeviceID -eq (Get-Partition -DriveLetter C | Get-Disk).Number }; $disk.MediaType`
          const { stdout: driveInfo } = await execFileAsync('powershell', [
            '-NoProfile', '-Command', psUtf8(diskScript)
          ], { timeout: 10000, windowsHide: true })
          isSSD = driveInfo.trim().toUpperCase() === 'SSD'
        } catch { /* Assume HDD if detection fails — safer to leave SysMain enabled */ }

        if (isSSD) {
          entries.push({
            id: randomUUID(),
            type: 'performance',
            keyPath: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\SysMain',
            valueName: 'Start',
            issue: 'SysMain (Superfetch) is enabled — unnecessary on your SSD, safe to disable',
            risk: 'low',
            selected: true,
            fix: { op: 'set-value', regType: 'REG_DWORD', data: '4' }
          })
        } else {
          entries.push({
            id: randomUUID(),
            type: 'performance',
            keyPath: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\SysMain',
            valueName: 'Start',
            issue: 'SysMain (Superfetch) is enabled — improves performance on HDDs, only disable if you have an SSD',
            risk: 'low',
            selected: false,
            fix: { op: 'set-value', regType: 'REG_DWORD', data: '4' }
          })
        }
      }
    } catch {
      // Skip
    }

    // --- NETWORK HARDENING ---

    // Check if LLMNR is enabled
    try {
      const llmnrKey = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient'
      const { stdout } = await execReg([
        'query', llmnrKey, '/v', 'EnableMulticast'
      ], { timeout: 5000 })
      const match = stdout.match(/EnableMulticast\s+REG_DWORD\s+0x(\d+)/i)
      if (!match || match[1] !== '0') {
        entries.push({
          id: randomUUID(),
          type: 'network',
          keyPath: llmnrKey,
          valueName: 'EnableMulticast',
          issue: 'LLMNR is enabled — vulnerable to name resolution poisoning attacks on local networks',
          risk: 'medium',
          selected: true,
          fix: { op: 'set-value', regType: 'REG_DWORD', data: '0' }
        })
      }
    } catch {
      entries.push({
        id: randomUUID(),
        type: 'network',
        keyPath: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient',
        valueName: 'EnableMulticast',
        issue: 'LLMNR is enabled by default — vulnerable to name resolution poisoning attacks',
        risk: 'medium',
        selected: true,
        fix: { op: 'set-value', regType: 'REG_DWORD', data: '0' }
      })
    }

    // Check if WPAD is not disabled
    try {
      const wpadKey = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Wpad'
      const { stdout } = await execReg([
        'query', wpadKey, '/v', 'WpadOverride'
      ], { timeout: 5000 })
      const match = stdout.match(/WpadOverride\s+REG_DWORD\s+0x(\d+)/i)
      if (!match || match[1] !== '1') {
        entries.push({
          id: randomUUID(),
          type: 'network',
          keyPath: wpadKey,
          valueName: 'WpadOverride',
          issue: 'WPAD auto-proxy discovery is enabled — can be exploited for man-in-the-middle attacks',
          risk: 'medium',
          selected: true,
          fix: { op: 'set-value', regType: 'REG_DWORD', data: '1' }
        })
      }
    } catch {
      entries.push({
        id: randomUUID(),
        type: 'network',
        keyPath: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Wpad',
        valueName: 'WpadOverride',
        issue: 'WPAD auto-proxy discovery is enabled — can be exploited for man-in-the-middle attacks',
        risk: 'medium',
        selected: true,
        fix: { op: 'set-value', regType: 'REG_DWORD', data: '1' }
      })
    }

    // --- SERVICES AUDIT ---
    // (DiagTrack, dmwappushservice, MapsBroker moved to Privacy Shield)

    // Check Fax service
    try {
      const { stdout } = await execReg([
        'query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Fax', '/v', 'Start'
      ], { timeout: 5000 })
      const match = stdout.match(/Start\s+REG_DWORD\s+0x(\d+)/i)
      if (match && (match[1] === '2' || match[1] === '3')) {
        entries.push({
          id: randomUUID(),
          type: 'service',
          keyPath: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Fax',
          valueName: 'Start',
          issue: `Fax service is ${match[1] === '2' ? 'set to auto-start' : 'enabled'} — unnecessary on most machines`,
          risk: 'low',
          selected: true,
          fix: { op: 'set-value', regType: 'REG_DWORD', data: '4' }
        })
      }
    } catch { /* Skip */ }

    // --- SCHEDULED TASKS CLEANUP ---
    // (MapsBroker moved to Privacy Shield)

    // Scan for orphaned scheduled tasks
    try {
      const { stdout } = await execNativeUtf8('schtasks', [
        '/query', '/fo', 'CSV', '/nh', '/v'
      ], { timeout: 20000 })

      const lines = stdout.split(/\r?\n/)
      const seen = new Set<string>()
      for (const line of lines) {
        // Parse CSV fields properly: handle escaped quotes ("") inside quoted fields
        const cols = parseCSVLine(line)
        // Verbose CSV: HostName(0), TaskName(1), ..., Task To Run(8), ...
        if (!cols || cols.length < 9) continue
        const taskName = cols[1]
        const taskToRun = cols[8].trim()

        if (!taskToRun || taskToRun === 'N/A' || taskToRun.startsWith('COM handler') || seen.has(taskName)) continue
        seen.add(taskName)

        const exePath = extractExePath(taskToRun)
        if (exePath) {
          if (exePath.includes('\\') && !exePath.toLowerCase().startsWith('c:\\windows\\') &&
              !exePath.startsWith('%') && !existsSync(exePath)) {
            entries.push({
              id: randomUUID(),
              type: 'task',
              keyPath: taskName,
              valueName: 'Task To Run',
              issue: `Scheduled task points to missing executable: ${exePath}`,
              risk: 'low',
              selected: true,
              fix: { op: 'delete-task' }
            })
          }
        }
      }
    } catch { /* Skip */ }

    // (Telemetry scheduled tasks moved to Privacy Shield)

    // Detect orphaned third-party update tasks
    const thirdPartyTasks = [
      { pattern: 'Adobe Acrobat Update', exe: 'AdobeARM.exe' },
      { pattern: 'Adobe Flash Player', exe: 'FlashPlayerUpdateService.exe' },
      { pattern: 'JavaUpdateSched', exe: 'jusched.exe' },
      { pattern: 'GoogleUpdate', exe: 'GoogleUpdate.exe' },
      { pattern: 'CCleaner', exe: 'CCleaner' }
    ]
    try {
      const { stdout } = await execNativeUtf8('schtasks', ['/query', '/fo', 'CSV', '/v', '/nh'], { timeout: 15000 })
      for (const task of thirdPartyTasks) {
        const matchingLines = stdout.split(/\r?\n/).filter(l => l.includes(task.pattern))
        for (const line of matchingLines) {
          const cols = parseCSVLine(line)
          if (cols && cols.length >= 9) {
            const taskName = cols[1]
            // Check if the executable actually exists — skip if the software is still installed
            const taskToRun = cols[8]
            const taskExe = taskToRun ? extractExePath(taskToRun) : null
            if (taskExe && existsSync(taskExe)) continue
            entries.push({
              id: randomUUID(),
              type: 'task',
              keyPath: taskName,
              valueName: 'Scheduled Task',
              issue: `Third-party update task "${task.pattern}" — may be for uninstalled software`,
              risk: 'low',
              selected: true,
              fix: { op: 'delete-task' }
            })
          }
        }
      }
    } catch { /* Skip */ }

    return entries
}

export async function fixRegistryEntries(
  entries: RegistryEntry[],
  onProgress?: (current: number, total: number, label: string) => void
): Promise<{ fixed: number; failed: number; failures: { issue: string; reason: string }[] }> {
    const total = entries.length

    // Create backup first
    onProgress?.(0, total, 'Creating registry backup...')
    const backupDir = join(homedir(), 'Documents', 'Kudu Backups')
    try {
      const { mkdirSync } = await import('fs')
      mkdirSync(backupDir, { recursive: true })
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupPath = join(backupDir, `registry-backup-${timestamp}.reg`)
      // Back up all hives that fix operations may modify
      await execReg(['export', 'HKLM\\SOFTWARE', backupPath, '/y'], { timeout: 30000 })
      const hkcuBackupPath = join(backupDir, `registry-backup-HKCU-${timestamp}.reg`)
      await execReg(['export', 'HKCU\\SOFTWARE', hkcuBackupPath, '/y'], { timeout: 30000 }).catch(() => {})
      // Back up HKLM\SYSTEM (services, event log sources) and HKCR (COM, interfaces, shell extensions)
      const systemBackupPath = join(backupDir, `registry-backup-SYSTEM-${timestamp}.reg`)
      await execReg(['export', 'HKLM\\SYSTEM\\CurrentControlSet\\Services', systemBackupPath, '/y'], { timeout: 60000 }).catch(() => {})
      // Back up HKCR branches that fix operations may delete from
      const hkcrClsidPath = join(backupDir, `registry-backup-HKCR-CLSID-${timestamp}.reg`)
      await execReg(['export', 'HKCR\\CLSID', hkcrClsidPath, '/y'], { timeout: 60000 }).catch(() => {})
      const hkcrIfacePath = join(backupDir, `registry-backup-HKCR-Interface-${timestamp}.reg`)
      await execReg(['export', 'HKCR\\Interface', hkcrIfacePath, '/y'], { timeout: 60000 }).catch(() => {})
      const hkcrMimePath = join(backupDir, `registry-backup-HKCR-MIME-${timestamp}.reg`)
      await execReg(['export', 'HKCR\\MIME', hkcrMimePath, '/y'], { timeout: 30000 }).catch(() => {})
      // Shell extension handlers are under HKCR\*\shellex, HKCR\Directory\shellex, HKCR\Folder\shellex
      const shellRoots = [
        { key: '*', file: 'AllFileTypes' },
        { key: 'Directory', file: 'Directory' },
        { key: 'Folder', file: 'Folder' }
      ]
      for (const { key, file } of shellRoots) {
        const shellPath = join(backupDir, `registry-backup-HKCR-${file}-shellex-${timestamp}.reg`)
        await execReg(['export', `HKCR\\${key}\\shellex`, shellPath, '/y'], { timeout: 30000 }).catch(() => {})
      }
    } catch {
      // Backup failed, but continue
    }

    let fixed = 0
    let failed = 0
    const failures: { issue: string; reason: string }[] = []

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (!entry || !entry.fix) {
        failed++
        failures.push({ issue: 'Unknown entry', reason: 'Entry data not found — try scanning again before fixing' })
        continue
      }

      const fix = entry.fix
      const key = fix.key || entry.keyPath
      const value = fix.value || entry.valueName

      onProgress?.(i + 1, total, `Fixing: ${entry.issue.substring(0, 80)}...`)

      try {
        switch (fix.op) {
          case 'delete-value':
            await execReg(['delete', key, '/v', value, '/f'], { timeout: 10000 })
            break

          case 'delete-key':
            await execReg(['delete', key, '/f'], { timeout: 10000 })
            break

          case 'set-value':
            if (fix.regType && fix.data !== undefined) {
              await execReg([
                'add', key, '/v', value, '/t', fix.regType, '/d', fix.data, '/f'
              ], { timeout: 10000 })
            }
            break

          case 'disable-task': {
            const disableParts = splitTaskPath(entry.keyPath)
            if (!disableParts) throw new Error('Invalid task path')
            const safeDisablePath = disableParts.path.replace(/'/g, "''")
            const safeDisableName = disableParts.name.replace(/'/g, "''")
            const disableScript = `Disable-ScheduledTask -TaskPath '${safeDisablePath}' -TaskName '${safeDisableName}' -ErrorAction Stop`
            await execFileAsync('powershell', [
              '-NoProfile', '-NonInteractive', '-Command', psUtf8(disableScript)
            ], { timeout: 10000, windowsHide: true })
            break
          }

          case 'delete-task': {
            const deleteParts = splitTaskPath(entry.keyPath)
            if (!deleteParts) throw new Error('Invalid task path')
            const safeDeletePath = deleteParts.path.replace(/'/g, "''")
            const safeDeleteName = deleteParts.name.replace(/'/g, "''")
            const deleteScript = `Unregister-ScheduledTask -TaskPath '${safeDeletePath}' -TaskName '${safeDeleteName}' -Confirm:$false -ErrorAction Stop`
            await execFileAsync('powershell', [
              '-NoProfile', '-NonInteractive', '-Command', psUtf8(deleteScript)
            ], { timeout: 10000, windowsHide: true })
            break
          }
        }
        fixed++
      } catch (err: any) {
        const stderr = err?.stderr || err?.message || 'Unknown error'
        const reason = stderr.includes('Access is denied') ? 'Access denied — run as administrator'
          : stderr.includes('cannot find') || stderr.includes('does not exist') ? 'Key or value no longer exists'
          : stderr.includes('network') ? 'Network error'
          : stderr.toString().split(/\r?\n/)[0].substring(0, 120) || 'Unknown error'
        failed++
        failures.push({ issue: entry.issue, reason })
      }
    }

    onProgress?.(total, total, 'Done')
    return { fixed, failed, failures }
}

export function registerRegistryCleanerIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.REGISTRY_SCAN, async (): Promise<RegistryEntry[]> => {
    if (process.platform !== 'win32') return []
    const entries = await scanRegistry()

    // Store entries in a new scan session
    const sessionMap = new Map<string, RegistryEntry>()
    for (const entry of entries) {
      sessionMap.set(entry.id, entry)
    }
    const scanId = randomUUID()
    scanSessions.set(scanId, sessionMap)

    // Clean up old sessions (keep only last 3)
    const sessionKeys = [...scanSessions.keys()]
    while (sessionKeys.length > 3) {
      scanSessions.delete(sessionKeys.shift()!)
    }

    return entries
  })

  ipcMain.handle(IPC.REGISTRY_FIX, async (_event, entryIds: string[]): Promise<{ fixed: number; failed: number; failures: { issue: string; reason: string }[] }> => {
    if (process.platform !== 'win32') return { fixed: 0, failed: 0, failures: [] }
    const valid = validateStringArray(entryIds)
    if (!valid) return { fixed: 0, failed: 0, failures: [] }
    // Search all sessions for the requested entries (avoids race if a new scan started)
    const entriesToFix: RegistryEntry[] = []
    for (const id of valid) {
      for (const session of scanSessions.values()) {
        const entry = session.get(id)
        if (entry) { entriesToFix.push(entry); break }
      }
    }

    return fixRegistryEntries(entriesToFix, (current, total, currentEntry) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send(IPC.REGISTRY_FIX_PROGRESS, { current, total, currentEntry })
    })
  })
}
