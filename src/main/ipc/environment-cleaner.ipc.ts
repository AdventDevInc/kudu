import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../../shared/channels'
import { CleanerType } from '../../shared/enums'
import { cacheItems } from '../services/scan-cache'
import { validateStringArray } from '../services/ipc-validation'
import { psUtf8, execNativeUtf8 } from '../services/exec-utf8'
import type { ScanItem, ScanResult, CleanResult, CleanError } from '../../shared/types'
import type { WindowGetter } from './index'

const execFileAsync = promisify(execFile)

/**
 * Expand %VAR% references in a Windows registry value.
 *
 * Looks up variables in `registryVars` first (merged user + system registry
 * environment) then falls back to `process.env`.  This ensures we resolve
 * references to registry variables that may not yet be loaded into the
 * current process environment (e.g. after recent env changes or cross-scope
 * references).
 */
function expandWinVars(value: string, registryVars: Map<string, string>): string {
  return value.replace(/%([^%]+)%/gi, (_match, varName: string) => {
    const lower = varName.toLowerCase()
    // 1. Check merged registry variables (authoritative source)
    for (const [key, val] of registryVars) {
      if (key.toLowerCase() === lower) return val
    }
    // 2. Fallback to current process environment
    for (const [key, val] of Object.entries(process.env)) {
      if (key.toLowerCase() === lower && val) return val
    }
    return _match // leave unexpanded if not found
  })
}

// ── Known developer environment variables that point to directories ──

// Only single-directory variables — excludes path-lists (NODE_PATH, PERL5LIB,
// GEM_PATH, CMAKE_PREFIX_PATH) and URIs (DOCKER_HOST) which would false-positive.
const DEV_ENV_VARS = [
  'JAVA_HOME', 'JDK_HOME', 'JRE_HOME',
  'GOROOT', 'GOBIN',
  'CARGO_HOME', 'RUSTUP_HOME',
  'NVM_HOME', 'NVM_DIR', 'NVM_SYMLINK',
  'CONDA_PREFIX', 'CONDA_HOME', 'VIRTUAL_ENV', 'PYENV_ROOT',
  'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_NDK_ROOT',
  'FLUTTER_ROOT', 'FLUTTER_HOME', 'PUB_CACHE',
  'GRADLE_HOME', 'GRADLE_USER_HOME', 'M2_HOME', 'MAVEN_HOME',
  'DOTNET_ROOT', 'DOTNET_INSTALL_DIR', 'NUGET_PACKAGES',
  'RUBY_HOME', 'GEM_HOME', 'RBENV_ROOT',
  'PERL_HOME',
  'PHP_HOME', 'COMPOSER_HOME',
  'SCALA_HOME', 'SBT_HOME',
  'HASKELL_HOME', 'STACK_ROOT', 'CABAL_DIR',
  'DENO_INSTALL', 'BUN_INSTALL',
  'PNPM_HOME', 'YARN_GLOBAL_FOLDER',
  'VCPKG_ROOT',
  'CUDA_PATH', 'CUDA_HOME',
  'DOCKER_CONFIG',
  'MINIKUBE_HOME', 'HELM_HOME',
  'TERRAFORM_HOME', 'PACKER_HOME',
  'GHCUP_HOME',
]

// ── Platform helpers ──

interface EnvEntry {
  /** The original variable name (e.g. 'PATH' or 'JAVA_HOME') */
  variable: string
  /** The orphaned value (full path for env vars, single entry for PATH) */
  value: string
  /** Where this comes from: 'user' or 'system' (Windows only) */
  scope: 'user' | 'system'
  /** The full PATH value (only for PATH entries, used during cleaning) */
  fullValue?: string
}

// ── Windows: read environment variables from the registry ──

async function readWinRegistryEnv(scope: 'user' | 'system'): Promise<Map<string, string>> {
  const key = scope === 'user'
    ? 'HKCU\\Environment'
    : 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'

  const vars = new Map<string, string>()
  try {
    const { stdout } = await execNativeUtf8('reg', [
      'query', key
    ], { timeout: 10000 })

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('HKEY_')) continue
      // reg query output: "    NAME    REG_SZ|REG_EXPAND_SZ    VALUE"
      const match = trimmed.match(/^\s*(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/i)
      if (match) {
        vars.set(match[1], match[2])
      }
    }
  } catch {
    // Scope not accessible (e.g. HKLM without admin)
  }
  return vars
}

async function scanWindowsPathEntries(): Promise<EnvEntry[]> {
  const orphaned: EnvEntry[] = []

  // Build merged registry vars from both scopes so expandWinVars can resolve
  // cross-scope references (e.g. a user PATH entry referencing %SystemRoot%)
  const mergedVars = new Map<string, string>()
  const systemVars = await readWinRegistryEnv('system')
  for (const [k, v] of systemVars) mergedVars.set(k, v)
  const userVars = await readWinRegistryEnv('user')
  for (const [k, v] of userVars) mergedVars.set(k, v)

  for (const scope of ['user', 'system'] as const) {
    const vars = scope === 'user' ? userVars : systemVars
    const pathValue = vars.get('Path') || vars.get('PATH') || vars.get('path')
    if (!pathValue) continue

    const entries = pathValue.split(';').map(e => e.trim()).filter(Boolean)
    for (const entry of entries) {
      const expanded = expandWinVars(entry, mergedVars)
      if (!existsSync(expanded)) {
        orphaned.push({ variable: 'PATH', value: entry, scope, fullValue: pathValue })
      }
    }
  }

  return orphaned
}

async function scanWindowsEnvVars(): Promise<EnvEntry[]> {
  const orphaned: EnvEntry[] = []

  // Build merged registry vars from both scopes for cross-scope resolution
  const mergedVars = new Map<string, string>()
  const systemVars = await readWinRegistryEnv('system')
  for (const [k, v] of systemVars) mergedVars.set(k, v)
  const userVars = await readWinRegistryEnv('user')
  for (const [k, v] of userVars) mergedVars.set(k, v)

  for (const scope of ['user', 'system'] as const) {
    const vars = scope === 'user' ? userVars : systemVars
    for (const [name, value] of vars) {
      if (name.toUpperCase() === 'PATH') continue
      if (!DEV_ENV_VARS.includes(name.toUpperCase()) && !DEV_ENV_VARS.includes(name)) continue

      const expanded = expandWinVars(value, mergedVars)
      if (!existsSync(expanded)) {
        orphaned.push({ variable: name, value, scope })
      }
    }
  }

  return orphaned
}

// ── macOS/Linux: scan PATH from the current process environment ──

function scanUnixPathEntries(): EnvEntry[] {
  const orphaned: EnvEntry[] = []
  const pathValue = process.env.PATH || ''
  const entries = pathValue.split(':').filter(Boolean)

  for (const entry of entries) {
    if (!existsSync(entry)) {
      orphaned.push({ variable: 'PATH', value: entry, scope: 'user', fullValue: pathValue })
    }
  }
  return orphaned
}

function scanUnixEnvVars(): EnvEntry[] {
  const orphaned: EnvEntry[] = []
  for (const name of DEV_ENV_VARS) {
    const value = process.env[name]
    if (!value) continue
    if (!existsSync(value)) {
      orphaned.push({ variable: name, value, scope: 'user' })
    }
  }
  return orphaned
}

// ── Windows cleaning: modify registry PATH and delete env vars ──

async function removeWindowsPathEntry(entry: EnvEntry): Promise<void> {
  const key = entry.scope === 'user'
    ? 'HKCU\\Environment'
    : 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'

  // Re-read current PATH to avoid stale data
  const vars = await readWinRegistryEnv(entry.scope)
  const currentPath = vars.get('Path') || vars.get('PATH') || vars.get('path') || ''
  const sep = ';'
  const entries = currentPath.split(sep).map(e => e.trim()).filter(Boolean)
  const filtered = entries.filter(e => e.toLowerCase() !== entry.value.toLowerCase())

  // Safety: never write an empty PATH — that would break the system
  if (filtered.length === 0) {
    throw new Error('Refusing to remove the last PATH entry')
  }

  const newPath = filtered.join(sep)

  await execNativeUtf8('reg', [
    'add', key, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', newPath, '/f'
  ], { timeout: 10000 })
}

async function removeWindowsEnvVar(entry: EnvEntry): Promise<void> {
  const key = entry.scope === 'user'
    ? 'HKCU\\Environment'
    : 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'

  await execNativeUtf8('reg', [
    'delete', key, '/v', entry.variable, '/f'
  ], { timeout: 10000 })
}

async function broadcastWinEnvChange(): Promise<void> {
  // Notify running applications that environment variables changed
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      psUtf8(`
        Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @'
          [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
          public static extern IntPtr SendMessageTimeout(
            IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
            uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
        $HWND_BROADCAST = [IntPtr]0xffff
        $WM_SETTINGCHANGE = 0x001A
        $result = [UIntPtr]::Zero
        [Win32.NativeMethods]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
      `)
    ], { timeout: 15000, windowsHide: true })
  } catch {
    // Best effort — apps may need a restart to see changes
  }
}

// ── macOS/Linux: scan-only ──
// For safety, we do NOT auto-edit shell config files (~/.bashrc, ~/.zshrc,
// /etc/paths.d/, etc.). Orphaned entries are reported for manual removal.

// ── IPC registration ──

/**
 * We store EnvEntry metadata alongside ScanItem so the cleaner can
 * reconstruct what needs to be modified. The `path` field stores an
 * encoded descriptor rather than a real file path.
 */
const envEntryCache = new Map<string, EnvEntry>()

export function registerEnvironmentCleanerIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.ENVIRONMENT_SCAN, async (): Promise<ScanResult[]> => {
    envEntryCache.clear()
    const results: ScanResult[] = []
    const category = CleanerType.Environment
    const isWin = process.platform === 'win32'

    const sendProgress = (current: number, total: number, currentPath: string) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.SCAN_PROGRESS, {
          phase: 'scanning',
          category,
          currentPath,
          progress: (current / total) * 100,
          itemsFound: results.reduce((s, r) => s + r.itemCount, 0),
          sizeFound: 0,
        })
      }
    }

    // --- Scan orphaned PATH entries ---
    sendProgress(0, 2, 'Scanning PATH entries...')
    let pathEntries: EnvEntry[]
    if (isWin) {
      pathEntries = await scanWindowsPathEntries()
    } else {
      pathEntries = scanUnixPathEntries()
    }

    if (pathEntries.length > 0) {
      const items: ScanItem[] = pathEntries.map(entry => {
        const id = randomUUID()
        envEntryCache.set(id, entry)
        return {
          id,
          path: `PATH \u2192 ${entry.value}`,
          size: 0,
          category,
          subcategory: `Orphaned PATH Entries (${entry.scope})`,
          lastModified: 0,
          selected: true,
        }
      })
      cacheItems(items)

      // Group by scope
      const byScope = new Map<string, ScanItem[]>()
      for (const item of items) {
        const list = byScope.get(item.subcategory) || []
        list.push(item)
        byScope.set(item.subcategory, list)
      }
      for (const [subcategory, scopeItems] of byScope) {
        results.push({
          category,
          subcategory,
          items: scopeItems,
          totalSize: 0,
          itemCount: scopeItems.length,
        })
      }
    }

    // --- Scan orphaned environment variables ---
    sendProgress(1, 2, 'Scanning environment variables...')
    let envVarEntries: EnvEntry[]
    if (isWin) {
      envVarEntries = await scanWindowsEnvVars()
    } else {
      envVarEntries = scanUnixEnvVars()
    }

    if (envVarEntries.length > 0) {
      const items: ScanItem[] = envVarEntries.map(entry => {
        const id = randomUUID()
        envEntryCache.set(id, entry)
        return {
          id,
          path: `${entry.variable} \u2192 ${entry.value}`,
          size: 0,
          category,
          subcategory: `Orphaned Environment Variables (${entry.scope})`,
          lastModified: 0,
          selected: true,
        }
      })
      cacheItems(items)

      const byScope = new Map<string, ScanItem[]>()
      for (const item of items) {
        const list = byScope.get(item.subcategory) || []
        list.push(item)
        byScope.set(item.subcategory, list)
      }
      for (const [subcategory, scopeItems] of byScope) {
        results.push({
          category,
          subcategory,
          items: scopeItems,
          totalSize: 0,
          itemCount: scopeItems.length,
        })
      }
    }

    sendProgress(2, 2, 'Environment scan complete')
    return results
  })

  ipcMain.handle(IPC.ENVIRONMENT_CLEAN, async (_event, itemIds: string[]): Promise<CleanResult> => {
    const valid = validateStringArray(itemIds)
    if (!valid) return { totalCleaned: 0, filesDeleted: 0, filesSkipped: 0, errors: [], needsElevation: false }

    const isWin = process.platform === 'win32'
    let filesDeleted = 0
    let filesSkipped = 0
    const errors: CleanError[] = []
    let lastReport = 0

    for (let i = 0; i < valid.length; i++) {
      const id = valid[i]
      const entry = envEntryCache.get(id)

      if (!entry) {
        filesSkipped++
        continue
      }

      // On non-Windows, we can only scan — cleaning requires manual shell config edits
      if (!isWin) {
        filesSkipped++
        errors.push({
          path: `${entry.variable} \u2192 ${entry.value}`,
          reason: 'Manual removal required \u2014 edit your shell config files',
        })
        continue
      }

      try {
        if (entry.variable === 'PATH') {
          await removeWindowsPathEntry(entry)
        } else {
          await removeWindowsEnvVar(entry)
        }
        filesDeleted++
      } catch (err: unknown) {
        filesSkipped++
        const msg = (err as Error).message || 'unknown error'
        if (msg.includes('Access is denied') || msg.includes('EACCES') || msg.includes('EPERM')) {
          errors.push({ path: `${entry.variable} \u2192 ${entry.value}`, reason: 'permission-denied' })
        } else {
          errors.push({ path: `${entry.variable} \u2192 ${entry.value}`, reason: msg })
        }
      }

      const now = Date.now()
      if (now - lastReport > 120 || i === valid.length - 1) {
        lastReport = now
        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send(IPC.SCAN_PROGRESS, {
          phase: 'cleaning',
          category: CleanerType.Environment,
          currentPath: entry ? `${entry.variable} \u2192 ${entry.value}` : '',
          progress: ((i + 1) / valid.length) * 100,
          itemsFound: valid.length,
          sizeFound: 0,
        })
      }
    }

    // Broadcast environment change to running apps on Windows
    if (isWin && filesDeleted > 0) {
      await broadcastWinEnvChange()
    }

    return {
      totalCleaned: 0,
      filesDeleted,
      filesSkipped,
      errors,
      needsElevation: errors.some(e => e.reason === 'permission-denied'),
    }
  })
}
