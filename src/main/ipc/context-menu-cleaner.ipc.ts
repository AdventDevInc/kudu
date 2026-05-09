import { app, ipcMain } from 'electron'
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { getBackupDir } from '../services/backup-dir'
import { join } from 'path'
import { createHash } from 'crypto'
import { IPC } from '../../shared/channels'
import { execNativeUtf8 } from '../services/exec-utf8'
import { isAdmin } from '../services/elevation'
import type {
  ContextMenuAction,
  ContextMenuApplyProgress,
  ContextMenuApplyRequest,
  ContextMenuApplyResult,
  ContextMenuEntry,
  ContextMenuEntryKind,
  ContextMenuHive,
  ContextMenuScanResult,
  ContextMenuScope,
  ContextMenuSource,
  ContextMenuStatus,
} from '../../shared/types'
import type { WindowGetter } from './index'

// ── reg.exe helper ──────────────────────────────────────────────────

async function execReg(args: string[], opts?: { timeout?: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  return execNativeUtf8('reg', args, opts)
}

// ── Cancellable scan state ──────────────────────────────────────────

let scanAbort: AbortController | null = null

// Session-scoped scan results so apply looks entries up by trusted in-memory
// state rather than renderer-supplied paths.
const scanSession = new Map<string, ContextMenuEntry>()

// ── Constants ────────────────────────────────────────────────────────

interface ScanRoot {
  hive: ContextMenuHive
  scope: ContextMenuScope
  shellPath: string         // HKCR\*\shell or HKCU\Software\Classes\*\shell etc.
  shellexPath: string       // …\shellex\ContextMenuHandlers
}

export const SCAN_ROOTS: ReadonlyArray<ScanRoot> = [
  // HKCR (machine-wide; HKLM-backed for any key not also in HKCU)
  { hive: 'HKCR', scope: 'AllFiles',             shellPath: 'HKCR\\*\\shell',                            shellexPath: 'HKCR\\*\\shellex\\ContextMenuHandlers' },
  { hive: 'HKCR', scope: 'Directory',            shellPath: 'HKCR\\Directory\\shell',                    shellexPath: 'HKCR\\Directory\\shellex\\ContextMenuHandlers' },
  { hive: 'HKCR', scope: 'DirectoryBackground',  shellPath: 'HKCR\\Directory\\Background\\shell',        shellexPath: 'HKCR\\Directory\\Background\\shellex\\ContextMenuHandlers' },
  { hive: 'HKCR', scope: 'Folder',               shellPath: 'HKCR\\Folder\\shell',                       shellexPath: 'HKCR\\Folder\\shellex\\ContextMenuHandlers' },
  { hive: 'HKCR', scope: 'Drive',                shellPath: 'HKCR\\Drive\\shell',                        shellexPath: 'HKCR\\Drive\\shellex\\ContextMenuHandlers' },
  { hive: 'HKCR', scope: 'AllFilesystemObjects', shellPath: 'HKCR\\AllFilesystemObjects\\shell',         shellexPath: 'HKCR\\AllFilesystemObjects\\shellex\\ContextMenuHandlers' },
  // HKCU mirrors (per-user; never need admin)
  { hive: 'HKCU', scope: 'AllFiles',             shellPath: 'HKCU\\Software\\Classes\\*\\shell',                            shellexPath: 'HKCU\\Software\\Classes\\*\\shellex\\ContextMenuHandlers' },
  { hive: 'HKCU', scope: 'Directory',            shellPath: 'HKCU\\Software\\Classes\\Directory\\shell',                    shellexPath: 'HKCU\\Software\\Classes\\Directory\\shellex\\ContextMenuHandlers' },
  { hive: 'HKCU', scope: 'DirectoryBackground',  shellPath: 'HKCU\\Software\\Classes\\Directory\\Background\\shell',        shellexPath: 'HKCU\\Software\\Classes\\Directory\\Background\\shellex\\ContextMenuHandlers' },
  { hive: 'HKCU', scope: 'Folder',               shellPath: 'HKCU\\Software\\Classes\\Folder\\shell',                       shellexPath: 'HKCU\\Software\\Classes\\Folder\\shellex\\ContextMenuHandlers' },
  { hive: 'HKCU', scope: 'Drive',                shellPath: 'HKCU\\Software\\Classes\\Drive\\shell',                        shellexPath: 'HKCU\\Software\\Classes\\Drive\\shellex\\ContextMenuHandlers' },
  { hive: 'HKCU', scope: 'AllFilesystemObjects', shellPath: 'HKCU\\Software\\Classes\\AllFilesystemObjects\\shell',         shellexPath: 'HKCU\\Software\\Classes\\AllFilesystemObjects\\shellex\\ContextMenuHandlers' },
]

/** Verb names that must never be touched — Windows core actions. */
export const VERB_SAFELIST: ReadonlyArray<string> = [
  'open', 'edit', 'print', 'printto', 'runas', 'opennewwindow',
  'opennewprocess', 'find', 'explore', 'cmd', 'properties',
  'cut', 'copy', 'paste', 'link', 'rename', 'delete', 'sendto',
  'pintohome', 'pintotaskbar', 'unpinfromtaskbar',
  'pintostartscreen', 'unpinfromstartscreen',
]

/** CLSIDs of essential Microsoft / Windows context-menu handlers. */
export const CLSID_SAFELIST: ReadonlyArray<string> = [
  '{09A47860-11B0-4DA5-AFA5-26D86198A780}', // Defender shell extension
  '{CB3D0F55-BC2C-4C1A-85ED-23ED75B5106B}', // OneDrive sync engine
  '{BB64F8A7-BEE7-4E1A-AB8D-7D8273F7FDB6}', // OneDrive (per-version)
  '{09799AFB-AD67-11D1-ABCD-00C04FC30936}', // "Open With"
  '{7BA4C740-9E81-11CF-99D3-00AA004AE837}', // "Send To"
  '{A470F8CF-A1E8-4f65-8335-227475AA5C46}', // "Send To" submenu
  '{F81E9010-6EA4-11CE-A7FF-00AA003CA9F6}', // Compressed (zipped) Folder
  '{888DCA60-FC0A-11CF-8F0F-00C04FD7D062}', // Compressed Folder send-to
  '{F39A0DC0-9CC8-11D0-A599-00C04FD64433}', // Sharing
  '{e82a2d71-5b2f-43a0-97b8-81be15854de8}', // Library Folder
  '{40dd6e20-7c17-11ce-a804-00aa003ca9f6}', // Briefcase
  '{ECCDF543-45CC-11CE-B9BF-0080C87CDBA6}', // DfsShlEx
  '{00021500-0000-0000-C000-000000000046}', // IQueryAssociations
  '{B41DB860-8EE4-11D2-9906-E49FADC173CA}', // RAR (when shipped by Windows)
]

interface SourcePattern {
  pattern: RegExp
  source: ContextMenuSource
}

/** Patterns used by inferSource — first match wins. */
const SOURCE_PATTERNS: ReadonlyArray<SourcePattern> = [
  { pattern: /onedrive/i,                   source: 'OneDrive' },
  { pattern: /7-?zip/i,                     source: '7-Zip' },
  { pattern: /winrar|rarext/i,              source: 'WinRAR' },
  { pattern: /notepad\+\+|nppshell/i,       source: 'Notepad++' },
  { pattern: /[\\/]code[\\/]|code\.exe|code-insiders|vs\s?code/i, source: 'VSCode' },
  { pattern: /defender|antimalware|msmpeng/i, source: 'Defender' },
  { pattern: /[\\/]git[\\/]|git-?bash|tortoisegit/i, source: 'Git' },
  { pattern: /dropbox/i,                    source: 'Dropbox' },
  { pattern: /googledrive|googlephotos/i,   source: 'Google Drive' },
  { pattern: /powertoys/i,                  source: 'PowerToys' },
  { pattern: /[\\/]system32[\\/]|[\\/]syswow64[\\/]|microsoft|windows/i, source: 'Microsoft' },
]

const DISABLED_STATE_VERSION = 1 as const

interface DisabledStateEntry {
  keyPath: string         // canonical (enabled) path
  originalName: string
  disabledAt: string      // ISO
  kind: ContextMenuEntryKind
}

interface DisabledStateFile {
  version: typeof DISABLED_STATE_VERSION
  entries: Record<string, DisabledStateEntry>
}

function disabledStatePath(): string {
  return join(app.getPath('userData'), 'context-menu-disabled.json')
}

// ── Pure helpers (exported for tests) ───────────────────────────────

const HIVE_ALIASES: Record<string, ContextMenuHive | null> = {
  HKEY_CLASSES_ROOT: 'HKCR',
  HKCR: 'HKCR',
  HKEY_CURRENT_USER: 'HKCU',
  HKCU: 'HKCU',
}

/** Convert long-form `HKEY_CLASSES_ROOT\…` to short `HKCR\…`. */
export function normalizeKeyPath(raw: string): string {
  const idx = raw.indexOf('\\')
  if (idx < 0) return raw
  const head = raw.substring(0, idx)
  const rest = raw.substring(idx)
  const short = HIVE_ALIASES[head]
  return short ? short + rest : raw
}

/** Return everything before the final backslash. */
export function parentKeyOf(keyPath: string): string {
  const idx = keyPath.lastIndexOf('\\')
  return idx < 0 ? keyPath : keyPath.substring(0, idx)
}

/** The on-disk subkey name when an entry is in the given status. */
export function disabledNameFor(kind: ContextMenuEntryKind, originalName: string): string {
  // Verbs use a LegacyDisable value, so the key name is unchanged.
  // Handlers are disabled by prefixing the subkey name with `-`.
  return kind === 'handler' ? '-' + originalName : originalName
}

/** A handler subkey whose name begins with `-` is disabled per Windows shellex rules. */
export function isDisabledHandlerName(name: string): boolean {
  return name.startsWith('-')
}

/** Match against VERB_SAFELIST — case-insensitive, whitespace-trimmed. */
export function isProtectedVerb(name: string): boolean {
  const normalized = name.trim().toLowerCase()
  return VERB_SAFELIST.includes(normalized)
}

/** Normalise braces/case before comparing against CLSID_SAFELIST. */
function canonicalClsid(raw: string): string {
  let v = raw.trim()
  if (!v) return ''
  if (!v.startsWith('{')) v = '{' + v
  if (!v.endsWith('}')) v = v + '}'
  return v.toLowerCase()
}

export function isProtectedClsid(clsid: string): boolean {
  if (!clsid) return false
  const target = canonicalClsid(clsid)
  return CLSID_SAFELIST.some((c) => canonicalClsid(c) === target)
}

const CLSID_RE = /^-?\{[0-9A-Fa-f-]+\}$/

/** Extract a CLSID from a string, returning canonical {GUID} form or null. */
export function extractClsid(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/\{[0-9A-Fa-f-]{30,}\}/)
  return m ? m[0] : null
}

/** Source inference — first matching pattern wins. */
export function inferSource(dllPath: string | null, keyName: string): ContextMenuSource {
  const haystack = `${dllPath ?? ''}|${keyName}`
  for (const { pattern, source } of SOURCE_PATTERNS) {
    if (pattern.test(haystack)) return source
  }
  return 'Unknown'
}

interface ParsedKey {
  keyPath: string
  values: Record<string, { type: string; data: string }>
}

/**
 * Parse `reg query <root> /s` output into a list of keys with their values.
 * Output format (4-space indentation, blank-line block separator):
 *
 *   HKEY_CLASSES_ROOT\*\shell\7-Zip
 *       (Default)    REG_SZ    7-Zip
 *       MUIVerb      REG_SZ    7-Zip
 *
 *   HKEY_CLASSES_ROOT\*\shell\7-Zip\command
 *       (Default)    REG_SZ    "C:\Program Files\7-Zip\7zG.exe" "%1"
 */
export function parseRegQueryBlocks(stdout: string): ParsedKey[] {
  const out: ParsedKey[] = []
  const lines = stdout.replace(/\r/g, '').split('\n')
  let current: ParsedKey | null = null

  for (const line of lines) {
    if (!line.trim()) {
      if (current) { out.push(current); current = null }
      continue
    }
    // Header lines are not indented and start with a hive name.
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      if (current) out.push(current)
      const headStr = line.trim()
      if (/^HKEY_/i.test(headStr)) {
        current = { keyPath: normalizeKeyPath(headStr), values: {} }
      } else {
        current = null
      }
      continue
    }
    if (!current) continue
    // Value line: 4 spaces, value-name, 4 spaces, REG_TYPE, 4 spaces, data.
    const m = line.match(/^\s{4}(.+?)\s{4}(REG_[A-Z_]+)\s{4}(.*)$/)
    if (m) {
      const [, name, type, data] = m
      current.values[name] = { type, data }
    }
  }
  if (current) out.push(current)
  return out
}

// ── Disabled-state file (atomic) ────────────────────────────────────

function readDisabledState(): DisabledStateFile {
  const empty: DisabledStateFile = { version: DISABLED_STATE_VERSION, entries: {} }
  try {
    const raw = readFileSync(disabledStatePath(), 'utf-8')
    const parsed = JSON.parse(raw) as DisabledStateFile
    if (parsed?.version !== DISABLED_STATE_VERSION || typeof parsed.entries !== 'object') {
      console.warn('[context-menu] disabled-state version mismatch, ignoring')
      return empty
    }
    return parsed
  } catch {
    return empty
  }
}

function writeDisabledState(state: DisabledStateFile): void {
  const target = disabledStatePath()
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
  renameSync(tmp, target)
}

// ── CLSID resolution (per-scan cache) ───────────────────────────────

interface ClsidInfo {
  friendlyName: string | null
  dllPath: string | null
}

async function resolveClsid(
  clsid: string,
  cache: Map<string, ClsidInfo>,
  signal: AbortSignal,
): Promise<ClsidInfo> {
  const canonical = canonicalClsid(clsid)
  const hit = cache.get(canonical)
  if (hit) return hit

  const info: ClsidInfo = { friendlyName: null, dllPath: null }
  try {
    const { stdout } = await execReg(['query', `HKCR\\CLSID\\${canonical}`, '/ve'], { timeout: 4000, signal })
    const m = stdout.match(/\(Default\)\s+REG_SZ\s+(.*)$/m)
    if (m) info.friendlyName = m[1].trim() || null
  } catch { /* missing key */ }
  try {
    const { stdout } = await execReg(['query', `HKCR\\CLSID\\${canonical}\\InprocServer32`, '/ve'], { timeout: 4000, signal })
    const m = stdout.match(/\(Default\)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/m)
    if (m) info.dllPath = m[1].trim().replace(/^"+|"+$/g, '') || null
  } catch { /* missing key */ }

  cache.set(canonical, info)
  return info
}

// ── Scan ────────────────────────────────────────────────────────────

function makeId(keyPath: string, name: string): string {
  return createHash('sha1').update(`${keyPath}|${name}`).digest('hex').substring(0, 16)
}

async function queryRoot(rootPath: string, signal: AbortSignal): Promise<ParsedKey[]> {
  try {
    const { stdout } = await execReg(['query', rootPath, '/s'], { timeout: 15000, signal })
    return parseRegQueryBlocks(stdout)
  } catch {
    return []
  }
}

async function scanShellVerbs(
  root: ScanRoot,
  signal: AbortSignal,
  disabled: DisabledStateFile,
): Promise<ContextMenuEntry[]> {
  const blocks = await queryRoot(root.shellPath, signal)
  if (blocks.length === 0) return []

  const rootKey = normalizeKeyPath(root.shellPath)
  const verbBlocks = new Map<string, ParsedKey>()      // verb keyPath → block
  const commandBlocks = new Map<string, ParsedKey>()   // verb keyPath → command block

  for (const block of blocks) {
    const rel = block.keyPath.startsWith(rootKey + '\\')
      ? block.keyPath.substring(rootKey.length + 1)
      : null
    if (!rel) continue
    const parts = rel.split('\\')
    if (parts.length === 1) {
      // <root>\<verb>
      verbBlocks.set(block.keyPath, block)
    } else if (parts.length === 2 && parts[1].toLowerCase() === 'command') {
      // <root>\<verb>\command
      const verbKey = parentKeyOf(block.keyPath)
      commandBlocks.set(verbKey, block)
    }
    // ignore deeper nesting for v1
  }

  const out: ContextMenuEntry[] = []
  for (const [keyPath, block] of verbBlocks) {
    const name = keyPath.substring(keyPath.lastIndexOf('\\') + 1)
    if (!name) continue
    const status: ContextMenuStatus = 'LegacyDisable' in block.values ? 'disabled' : 'enabled'
    const command = commandBlocks.get(keyPath)?.values['(Default)']?.data?.trim() || null
    const muiVerb = block.values.MUIVerb?.data?.trim() || ''
    const defaultLabel = block.values['(Default)']?.data?.trim() || ''
    const displayName = stripMuiResource(muiVerb) || defaultLabel || name
    const id = makeId(keyPath, name)
    const protectedFlag = isProtectedVerb(name)
    const requiresAdmin = root.hive === 'HKCR'

    out.push({
      id,
      kind: 'verb',
      keyPath,
      name,
      displayName,
      scope: root.scope,
      hive: root.hive,
      clsid: null,
      dllPath: null,
      command,
      source: inferSource(command, name),
      status,
      protected: protectedFlag,
      requiresAdmin,
      selected: false,
    })

    // If our DisabledState says we disabled this entry but on-disk says enabled,
    // trust the on-disk reading; the verb may have been re-enabled out-of-band.
    if (status === 'enabled' && disabled.entries[id]) {
      delete disabled.entries[id]
    }
  }
  return out
}

/** Strip "@C:\…\foo.dll,-123" resource references that show up in MUIVerb. */
function stripMuiResource(s: string): string {
  if (!s) return ''
  if (s.startsWith('@')) return ''
  return s
}

async function scanShellHandlers(
  root: ScanRoot,
  signal: AbortSignal,
  clsidCache: Map<string, ClsidInfo>,
  disabled: DisabledStateFile,
): Promise<ContextMenuEntry[]> {
  const blocks = await queryRoot(root.shellexPath, signal)
  if (blocks.length === 0) return []

  const rootKey = normalizeKeyPath(root.shellexPath)
  const out: ContextMenuEntry[] = []

  for (const block of blocks) {
    if (!block.keyPath.startsWith(rootKey + '\\')) continue
    const rel = block.keyPath.substring(rootKey.length + 1)
    if (rel.includes('\\')) continue // only direct children
    const onDiskName = rel
    const isDisabled = isDisabledHandlerName(onDiskName)
    const logicalName = isDisabled ? onDiskName.substring(1) : onDiskName

    // CLSID source: subkey name itself (when name is a {GUID}) or (Default) value.
    const subkeyClsid = CLSID_RE.test(onDiskName) ? extractClsid(onDiskName) : null
    const defaultClsid = extractClsid(block.values['(Default)']?.data ?? null)
    const clsid = subkeyClsid ?? defaultClsid

    const canonicalKey = parentKeyOf(block.keyPath) + '\\' + logicalName
    // Use on-disk path so the enabled and disabled forms of the same handler
    // (the "reinstall ghost" case) produce distinct ids and surface as separate rows.
    const id = makeId(block.keyPath, onDiskName)

    let info: ClsidInfo = { friendlyName: null, dllPath: null }
    if (clsid) {
      try { info = await resolveClsid(clsid, clsidCache, signal) } catch { /* skip */ }
    }
    const friendly = stripMuiResource(info.friendlyName?.trim() || '')
    const displayName = friendly || logicalName

    const protectedFlag = clsid ? isProtectedClsid(clsid) : false
    const requiresAdmin = root.hive === 'HKCR'
    const status: ContextMenuStatus = isDisabled ? 'disabled' : 'enabled'

    out.push({
      id,
      kind: 'handler',
      keyPath: canonicalKey,
      name: logicalName,
      displayName,
      scope: root.scope,
      hive: root.hive,
      clsid: clsid,
      dllPath: info.dllPath,
      command: null,
      source: inferSource(info.dllPath, logicalName),
      status,
      protected: protectedFlag,
      requiresAdmin,
      selected: false,
    })

    if (status === 'enabled' && disabled.entries[id]) {
      delete disabled.entries[id]
    }
  }
  return out
}

export async function scanContextMenu(
  signal: AbortSignal,
  onProgress?: (current: number, total: number, label: string) => void,
): Promise<ContextMenuScanResult> {
  if (process.platform !== 'win32') {
    return { entries: [], scanDuration: 0, scanned: 0 }
  }
  const start = Date.now()
  const clsidCache = new Map<string, ClsidInfo>()
  const disabled = readDisabledState()
  const all: ContextMenuEntry[] = []
  let scanned = 0
  const total = SCAN_ROOTS.length

  for (let i = 0; i < SCAN_ROOTS.length; i++) {
    if (signal.aborted) break
    const root = SCAN_ROOTS[i]
    onProgress?.(i, total, `${root.hive} ${root.scope}`)
    try {
      const verbs = await scanShellVerbs(root, signal, disabled)
      const handlers = await scanShellHandlers(root, signal, clsidCache, disabled)
      all.push(...verbs, ...handlers)
      scanned += verbs.length + handlers.length
    } catch {
      // skip root on error (permission denied, abort, etc.)
    }
  }

  // Persist any pruning of stale DisabledState entries detected during scan.
  try { writeDisabledState(disabled) } catch { /* skip */ }

  return { entries: all, scanDuration: Date.now() - start, scanned }
}

// ── Apply ────────────────────────────────────────────────────────────

const BACKUP_DIR = () => getBackupDir()

function pruneOldBackups(backupDir: string, keep: number): void {
  try {
    const files = readdirSync(backupDir).filter((f: string) => f.startsWith('registry-backup-') && f.endsWith('.reg'))
    // Group by timestamp suffix `-<ts>.reg`.
    const groups = new Map<string, string[]>()
    for (const file of files) {
      const m = file.match(/-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.reg$/)
      if (!m) continue
      const ts = m[1]
      const list = groups.get(ts) ?? []
      list.push(file)
      groups.set(ts, list)
    }
    const stale = [...groups.keys()].sort().reverse().slice(keep)
    for (const ts of stale) {
      for (const f of groups.get(ts)!) {
        try { unlinkSync(join(backupDir, f)) } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
}

async function backupShellExtensionHives(signal?: AbortSignal): Promise<void> {
  const backupDir = BACKUP_DIR()
  try { mkdirSync(backupDir, { recursive: true }) } catch { /* skip */ }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

  const targets: { src: string; file: string }[] = [
    { src: 'HKCR\\*\\shellex',                   file: 'AllFileTypes' },
    { src: 'HKCR\\Directory\\shellex',           file: 'Directory' },
    { src: 'HKCR\\Directory\\Background\\shellex', file: 'DirectoryBackground' },
    { src: 'HKCR\\Folder\\shellex',              file: 'Folder' },
    { src: 'HKCR\\Drive\\shellex',               file: 'Drive' },
    { src: 'HKCR\\AllFilesystemObjects\\shellex', file: 'AllFilesystemObjects' },
    { src: 'HKCR\\*\\shell',                     file: 'AllFileTypes-shell' },
    { src: 'HKCR\\Directory\\shell',             file: 'Directory-shell' },
    { src: 'HKCR\\Directory\\Background\\shell', file: 'DirectoryBackground-shell' },
    { src: 'HKCR\\Folder\\shell',                file: 'Folder-shell' },
    { src: 'HKCU\\Software\\Classes',            file: 'HKCU-Classes' },
  ]
  for (const { src, file } of targets) {
    const dest = join(backupDir, `registry-backup-context-menu-${file}-${timestamp}.reg`)
    await execReg(['export', src, dest, '/y'], { timeout: 30000, signal }).catch(() => { /* skip */ })
  }
  pruneOldBackups(backupDir, 3)
}

async function applyOne(
  entry: ContextMenuEntry,
  action: ContextMenuAction,
  signal?: AbortSignal,
): Promise<{ ok: true; newStatus: ContextMenuStatus } | { ok: false; reason: string }> {
  if (entry.protected && action !== 'enable') {
    return { ok: false, reason: 'Entry is protected and cannot be modified.' }
  }
  if (entry.requiresAdmin && !isAdmin()) {
    return { ok: false, reason: 'Access denied — run Kudu as administrator.' }
  }

  try {
    if (entry.kind === 'verb') {
      if (action === 'disable') {
        await execReg(['add', entry.keyPath, '/v', 'LegacyDisable', '/t', 'REG_SZ', '/d', '', '/f'], { timeout: 8000, signal })
        return { ok: true, newStatus: 'disabled' }
      } else if (action === 'enable') {
        await execReg(['delete', entry.keyPath, '/v', 'LegacyDisable', '/f'], { timeout: 8000, signal }).catch(() => { /* idempotent */ })
        return { ok: true, newStatus: 'enabled' }
      } else { // delete
        await execReg(['delete', entry.keyPath, '/f'], { timeout: 8000, signal })
        return { ok: true, newStatus: 'enabled' /* gone */ }
      }
    } else { // handler
      const parent = parentKeyOf(entry.keyPath)
      const enabledPath = entry.keyPath
      const disabledPath = parent + '\\-' + entry.name

      if (action === 'disable') {
        if (entry.status === 'disabled') return { ok: true, newStatus: 'disabled' }
        await execReg(['copy', enabledPath, disabledPath, '/s', '/f'], { timeout: 8000, signal })
        await execReg(['delete', enabledPath, '/f'], { timeout: 8000, signal })
        return { ok: true, newStatus: 'disabled' }
      } else if (action === 'enable') {
        if (entry.status === 'enabled') return { ok: true, newStatus: 'enabled' }
        await execReg(['copy', disabledPath, enabledPath, '/s', '/f'], { timeout: 8000, signal })
        await execReg(['delete', disabledPath, '/f'], { timeout: 8000, signal })
        return { ok: true, newStatus: 'enabled' }
      } else { // delete
        const target = entry.status === 'disabled' ? disabledPath : enabledPath
        await execReg(['delete', target, '/f'], { timeout: 8000, signal })
        return { ok: true, newStatus: 'enabled' /* gone */ }
      }
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    return { ok: false, reason: cleanRegError(message) }
  }
}

function cleanRegError(message: string): string {
  // reg.exe error messages usually start with "ERROR: ".
  const m = message.match(/ERROR:\s*(.+?)(?:\r?\n|$)/)
  if (m) return m[1].trim()
  if (/access is denied/i.test(message)) return 'Access denied — run Kudu as administrator.'
  if (/cancel/i.test(message)) return 'Operation cancelled'
  return message.length > 200 ? message.substring(0, 200) + '…' : message
}

export async function applyContextMenu(
  requests: ContextMenuApplyRequest[],
  onProgress?: (p: ContextMenuApplyProgress) => void,
  signal?: AbortSignal,
): Promise<ContextMenuApplyResult> {
  const total = requests.length
  const result: ContextMenuApplyResult = { succeeded: 0, failed: 0, errors: [], updates: [] }
  if (total === 0) return result

  onProgress?.({ current: 0, total, currentLabel: 'Backing up registry…' })
  await backupShellExtensionHives(signal)

  const disabled = readDisabledState()

  for (let i = 0; i < requests.length; i++) {
    if (signal?.aborted) break
    const req = requests[i]
    const entry = scanSession.get(req.entryId) ?? null
    onProgress?.({
      current: i + 1,
      total,
      currentLabel: entry ? `${labelForAction(req.action)} ${entry.displayName}` : `${labelForAction(req.action)} (unknown)`
    })
    if (!entry) {
      result.failed++
      result.errors.push({ entryId: req.entryId, displayName: '(unknown)', reason: 'Entry not found — re-scan and try again.' })
      continue
    }

    const outcome = await applyOne(entry, req.action, signal)
    if (outcome.ok) {
      result.succeeded++
      entry.status = outcome.newStatus
      result.updates.push({ entryId: req.entryId, status: outcome.newStatus })
      if (req.action === 'disable') {
        disabled.entries[req.entryId] = {
          keyPath: entry.keyPath,
          originalName: entry.name,
          disabledAt: new Date().toISOString(),
          kind: entry.kind,
        }
      } else {
        delete disabled.entries[req.entryId]
        if (req.action === 'delete') scanSession.delete(req.entryId)
      }
    } else {
      result.failed++
      result.errors.push({ entryId: req.entryId, displayName: entry.displayName, reason: outcome.reason })
    }
  }

  try { writeDisabledState(disabled) } catch { /* skip */ }
  return result
}

function labelForAction(action: ContextMenuAction): string {
  switch (action) {
    case 'disable': return 'Disabling'
    case 'enable':  return 'Enabling'
    case 'delete':  return 'Deleting'
  }
}

// ── IPC registration ─────────────────────────────────────────────────

function isApplyRequestArray(input: unknown): input is ContextMenuApplyRequest[] {
  if (!Array.isArray(input)) return false
  return input.every((r) =>
    r && typeof r === 'object'
    && typeof (r as ContextMenuApplyRequest).entryId === 'string'
    && (r as ContextMenuApplyRequest).action !== undefined
    && ['disable', 'enable', 'delete'].includes((r as ContextMenuApplyRequest).action),
  )
}

export function registerContextMenuCleanerIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.CONTEXT_MENU_SCAN, async (): Promise<ContextMenuScanResult> => {
    if (process.platform !== 'win32') {
      return { entries: [], scanDuration: 0, scanned: 0 }
    }
    scanAbort?.abort()
    scanAbort = new AbortController()
    try {
      const result = await scanContextMenu(scanAbort.signal)
      scanSession.clear()
      for (const e of result.entries) scanSession.set(e.id, e)
      return result
    } finally {
      scanAbort = null
    }
  })

  ipcMain.handle(IPC.CONTEXT_MENU_SCAN_CANCEL, async () => {
    scanAbort?.abort()
  })

  ipcMain.handle(IPC.CONTEXT_MENU_APPLY, async (_event, payload: unknown): Promise<ContextMenuApplyResult> => {
    if (process.platform !== 'win32') {
      return { succeeded: 0, failed: 0, errors: [], updates: [] }
    }
    if (!isApplyRequestArray(payload)) {
      return {
        succeeded: 0,
        failed: 0,
        errors: [{ entryId: '', displayName: '(invalid request)', reason: 'Malformed payload — expected an array of {entryId, action}.' }],
        updates: [],
      }
    }
    return applyContextMenu(payload, (progress) => {
      try { getWindow()?.webContents.send(IPC.CONTEXT_MENU_APPLY_PROGRESS, progress) } catch { /* skip */ }
    })
  })
}
