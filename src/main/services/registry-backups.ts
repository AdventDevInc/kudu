import { lstat, open, readdir, readFile, realpath, rm, writeFile } from 'fs/promises'
import { dirname, join, relative } from 'path'
import { getBackupDir } from './backup-dir'
import { isAdmin } from './elevation'
import { execNativeUtf8, execTracked, psUtf8 } from './exec-utf8'
import {
  createPrivateTempDir,
  readSeals,
  removeSeals,
  sealBackup,
  sha256Hex,
  sweepSeals
} from './registry-backup-seal'
import type {
  RegistryBackup,
  RegistryBackupBlock,
  RegistryBackupSource,
  RegistryRestoreResult
} from '../../shared/recovery'

/**
 * Restore support for the `.reg` backups Kudu writes before changing the registry.
 *
 * Only *targeted* backups are restorable. A file is targeted when:
 *  1. its name is `registry-backup-targeted-<ts>.reg` (registry cleaner),
 *     `pre-restore-backup-<ts>.reg` (written here) or `privacy-traces-backup-*.reg`
 *     — every other `registry-backup-*` file is a full-branch export by the
 *     registry cleaner (`backupMode: 'full'`) or the context-menu cleaner; and
 *  2. none of its top-level keys is a hive, a hive's direct child, or one of the
 *     branch roots those full exports cover (`BROAD_ROOTS`); and
 *  3. it has at most `MAX_SECTIONS` keys and `MAX_TARGETED_BYTES` bytes; and
 *  4. its exact bytes match the seal Kudu recorded in HKLM when writing it
 *     (`registry-backup-seal.ts`), since the backup folder is user-writable
 *     while the import runs elevated.
 * Importing a broad export would roll back every unrelated change made since.
 */

const HKLM = 'HKEY_LOCAL_MACHINE'
const HKCU = 'HKEY_CURRENT_USER'
const HKCR = 'HKEY_CLASSES_ROOT'
const REG_HEADER = 'Windows Registry Editor Version 5.00'
const TS = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z'
const BACKUP_NAME =
  /^(?:registry-backup-|privacy-traces-backup-|pre-restore-backup-)[A-Za-z0-9_.-]{1,160}\.reg$/
const TARGETED_REGISTRY = new RegExp(`^registry-backup-targeted-${TS}\\.reg$`)
const PRE_RESTORE = new RegExp(`^pre-restore-backup-${TS}\\.reg$`)
const MAX_TARGETED_BYTES = 32 * 1024 * 1024
const MAX_SECTIONS = 10_000
const MAX_LISTED = 100
const MAX_KEYS_SHOWN = 50

/**
 * Branches each feature may write to; every key in its backups must sit in one.
 * A scope root itself as a top-level key is then rejected as broad (`isBroadRoot`).
 */
const SOURCE_SCOPES: Record<Exclude<RegistryBackupSource, 'pre-restore'>, string[]> = {
  registry: [
    `${HKLM}\\SOFTWARE`,
    `${HKCU}\\SOFTWARE`,
    HKCR,
    `${HKLM}\\SYSTEM\\CurrentControlSet\\Services`,
    `${HKLM}\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server`
  ],
  'context-menu': [HKCR, `${HKCU}\\SOFTWARE\\Classes`],
  'privacy-traces': [`${HKCU}\\SOFTWARE`]
}
// A pre-restore backup only ever holds keys from a file that already passed validation.
const PRE_RESTORE_SCOPES = [...new Set(Object.values(SOURCE_SCOPES).flat())]

/** Refused anywhere in a file, whatever its source. */
const FORBIDDEN_KEYS = [
  /^HKEY_LOCAL_MACHINE\\(SAM|SECURITY)(\\|$)/i,
  /^HKEY_LOCAL_MACHINE\\SYSTEM\\[^\\]+\\Control\\Session Manager(\\|$)/i,
  /^HKEY_(LOCAL_MACHINE|CURRENT_USER)\\SOFTWARE\\(WOW6432Node\\)?Microsoft\\Windows NT\\CurrentVersion\\(Winlogon|Image File Execution Options)(\\|$)/i
]

/** Branch roots that only a full export would contain as a top-level key. */
const BROAD_ROOTS = new Set(
  [
    `${HKLM}\\SOFTWARE\\Classes`,
    `${HKLM}\\SOFTWARE\\Clients`,
    `${HKLM}\\SOFTWARE\\Microsoft`,
    `${HKLM}\\SOFTWARE\\Policies`,
    `${HKLM}\\SOFTWARE\\WOW6432Node`,
    `${HKLM}\\SOFTWARE\\WOW6432Node\\Microsoft`,
    `${HKCU}\\SOFTWARE\\Classes`,
    `${HKCU}\\SOFTWARE\\Microsoft`,
    `${HKCU}\\SOFTWARE\\Policies`,
    `${HKLM}\\SYSTEM\\CurrentControlSet`,
    `${HKLM}\\SYSTEM\\CurrentControlSet\\Control`,
    `${HKLM}\\SYSTEM\\CurrentControlSet\\Services`,
    ...[
      'CLSID',
      'Interface',
      'TypeLib',
      'MIME',
      'MIME\\Database',
      'WOW6432Node',
      'WOW6432Node\\CLSID'
    ].map((k) => `${HKCR}\\${k}`),
    ...[
      '*',
      'Directory',
      'Directory\\Background',
      'Folder',
      'Drive',
      'AllFilesystemObjects'
    ].flatMap((k) => [`${HKCR}\\${k}`, `${HKCR}\\${k}\\shell`, `${HKCR}\\${k}\\shellex`])
  ].map((k) => k.toUpperCase())
)

const SHORT_HIVES: Record<string, string> = { [HKLM]: 'HKLM', [HKCU]: 'HKCU', [HKCR]: 'HKCR' }

export function classifyBackupName(name: string): {
  source: RegistryBackupSource
  targeted: boolean
} {
  if (TARGETED_REGISTRY.test(name)) return { source: 'registry', targeted: true }
  if (name.startsWith('registry-backup-context-menu-'))
    return { source: 'context-menu', targeted: false }
  if (name.startsWith('privacy-traces-backup-')) return { source: 'privacy-traces', targeted: true }
  if (name.startsWith('pre-restore-backup-'))
    return { source: 'pre-restore', targeted: PRE_RESTORE.test(name) }
  return { source: 'registry', targeted: false }
}

/** One `[KEY]` or `[-KEY]` section. Value names are unescaped; `''` is the default value (`@`). */
export type RegSection = {
  key: string
  deleted: boolean
  values: string[]
  deletedValues: string[]
}

export type ParsedRegExport =
  { ok: true; keys: string[]; sections: RegSection[] } | { ok: false; reason: RegistryBackupBlock }

// `reg export` escapes only `\` and `"` inside quoted names and strings.
const QUOTED = '"(?:[^"\\\\\\r\\n]|\\\\["\\\\])*"'
const VALUE_LINE = new RegExp(`^(@|${QUOTED})=(.*)$`)
const STRING_DATA = new RegExp(`^${QUOTED}$`)
const DWORD_DATA = /^dword:[0-9a-fA-F]{8}$/
const HEX_DATA = /^hex(?:\([0-9a-fA-F]{1,8}\))?:(.*)$/
const HEX_BYTES = /^(?:[0-9a-fA-F]{2}(?:,[0-9a-fA-F]{2})*(?:,\\)?|\\)?$/
const HEX_CONTINUATION = /^ +[0-9a-fA-F]{2}(?:,[0-9a-fA-F]{2})*(?:,\\)?$/

function unquote(name: string): string {
  return name === '@' ? '' : name.slice(1, -1).replace(/\\(["\\])/g, '$1')
}

/**
 * Parse a `reg export` file: UTF-16LE with a BOM, the version-5 header line,
 * CRLF line endings, and only the line shapes `reg export` writes. Anything
 * else is refused as `format` — notably a string whose data spans lines, which
 * `reg export` writes raw and `reg import` would read as further entries.
 *
 * Deletion entries (`[-KEY]`, `"name"=-`) are refused unless `allowDeletions`:
 * `reg export` never writes them. Only sealed pre-restore backups may hold them.
 */
export function parseRegExport(buf: Buffer, allowDeletions = false): ParsedRegExport {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xfe || buf.length % 2 !== 0)
    return { ok: false, reason: 'format' }
  const lines = buf.toString('utf16le', 2).split('\r\n')
  if (lines[0] !== REG_HEADER) return { ok: false, reason: 'format' }
  const sections: RegSection[] = []
  let section: RegSection | null = null
  let continued = false
  for (const line of lines.slice(1)) {
    if (/[\r\n]/.test(line)) return { ok: false, reason: 'format' }
    if (continued) {
      if (!HEX_CONTINUATION.test(line)) return { ok: false, reason: 'format' }
      continued = line.endsWith('\\')
      continue
    }
    if (line === '') continue
    const header = /^\[(-?)(.+)\]$/.exec(line)
    if (header) {
      if (header[1] && !allowDeletions) return { ok: false, reason: 'deletion' }
      section = { key: header[2]!, deleted: !!header[1], values: [], deletedValues: [] }
      sections.push(section)
      continue
    }
    const value = VALUE_LINE.exec(line)
    if (!value || !section || section.deleted) return { ok: false, reason: 'format' }
    const [, name, data] = value as unknown as [string, string, string]
    if (data === '-') {
      if (!allowDeletions) return { ok: false, reason: 'deletion' }
      section.deletedValues.push(unquote(name))
      continue
    }
    const hex = HEX_DATA.exec(data)
    if (hex) {
      if (!HEX_BYTES.test(hex[1]!)) return { ok: false, reason: 'format' }
      continued = hex[1]!.endsWith('\\')
    } else if (!STRING_DATA.test(data) && !DWORD_DATA.test(data)) {
      return { ok: false, reason: 'format' }
    }
    section.values.push(unquote(name))
  }
  if (continued) return { ok: false, reason: 'format' }
  return sections.length
    ? { ok: true, keys: sections.map((s) => s.key), sections }
    : { ok: false, reason: 'empty' }
}

/** Quote a value name the way `reg export` does; `''` is the default value. */
export function regValueName(name: string): string {
  return name === '' ? '@' : `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** True when `key` is `scope` or one of its subkeys. */
function isUnder(key: string, scope: string): boolean {
  const k = key.toUpperCase()
  const s = scope.toUpperCase()
  return k === s || k.startsWith(s + '\\')
}

/** Keys with no ancestor in the file, i.e. the keys `reg export` was pointed at. */
export function topLevelKeys(keys: string[]): string[] {
  const all = new Set(keys.map((k) => k.toUpperCase()))
  const roots: string[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    const parts = key.toUpperCase().split('\\')
    let nested = false
    for (let i = parts.length - 1; i > 0 && !nested; i--) {
      nested = all.has(parts.slice(0, i).join('\\'))
    }
    if (!nested && !seen.has(key.toUpperCase())) {
      seen.add(key.toUpperCase())
      roots.push(key)
    }
  }
  return roots
}

export function isBroadRoot(key: string): boolean {
  const upper = key.toUpperCase()
  const parts = upper.split('\\')
  if (parts.length <= 1) return true
  if (parts[0] !== HKCR.toUpperCase() && parts.length <= 2) return true
  return BROAD_ROOTS.has(upper)
}

/** Branches the named backup's keys must sit in. */
function scopesFor(name: string): string[] {
  const { source } = classifyBackupName(name)
  return source === 'pre-restore' ? PRE_RESTORE_SCOPES : SOURCE_SCOPES[source]
}

/** `A\B\C` → `A\B`; null for a hive. */
export function parentKey(key: string): string | null {
  const idx = key.lastIndexOf('\\')
  return idx > 0 ? key.slice(0, idx) : null
}

/**
 * Whether a tombstone may delete `key`: strictly below one of `scopes` (never
 * a scope root itself), not a branch root, and not a key that is always refused.
 */
export function isDeletableAncestor(key: string, scopes: string[]): boolean {
  const upper = key.toUpperCase()
  return (
    !key.split('\\').some((part) => part === '') &&
    !isBroadRoot(key) &&
    !FORBIDDEN_KEYS.some((re) => re.test(key)) &&
    scopes.some((scope) => isUnder(key, scope) && upper !== scope.toUpperCase())
  )
}

export type BackupAssessment = {
  keys: string[]
  requiresAdmin: boolean
  blocked?: RegistryBackupBlock
  sections: RegSection[]
}

/**
 * Decide whether a backup's contents may be imported. `sealed` says whether its
 * bytes match the seal Kudu recorded; unsealed files are never restorable, and
 * only a sealed pre-restore backup may delete anything. Pure — exported for tests.
 */
export function assessRegistryBackup(name: string, buf: Buffer, sealed: boolean): BackupAssessment {
  const { targeted } = classifyBackupName(name)
  const parsed = parseRegExport(buf, sealed && PRE_RESTORE.test(name))
  if (!parsed.ok) return { keys: [], requiresAdmin: false, blocked: parsed.reason, sections: [] }
  const { sections } = parsed
  const roots = topLevelKeys(parsed.keys)
  // Restoring anything needs elevation, even HKCU-only files: the pre-restore
  // backup is sealed in HKLM and the import runs from an admin-only folder.
  const result = { keys: roots, requiresAdmin: true, sections }
  const scopes = scopesFor(name)
  const forbidden = parsed.keys.some(
    (k) =>
      k.split('\\').some((part) => part === '') ||
      FORBIDDEN_KEYS.some((re) => re.test(k)) ||
      !scopes.some((scope) => isUnder(k, scope))
  )
  // A tombstone may only remove a key Kudu itself restored (or a parent that
  // restore created), never a scope or branch root.
  if (forbidden || sections.some((s) => s.deleted && !isDeletableAncestor(s.key, scopes)))
    return { ...result, blocked: 'forbidden-key' }
  if (!targeted || parsed.keys.length > MAX_SECTIONS || roots.some(isBroadRoot))
    return { ...result, blocked: 'full-export' }
  if (!sealed) return { ...result, blocked: 'unverified' }
  return result
}

/** First key of a (possibly huge) export, read from its first 64 KiB. */
async function readFirstKey(path: string): Promise<string[]> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    if (bytesRead < 2 || buf[0] !== 0xff || buf[1] !== 0xfe) return []
    const text = buf.toString('utf16le', 2, bytesRead - (bytesRead % 2))
    const match = /^\[([^\r\n]+)\]\r?$/m.exec(text)
    return match ? [match[1]!] : []
  } finally {
    await handle.close()
  }
}

async function describeBackup(
  dir: string,
  name: string,
  seals: Map<string, string>
): Promise<RegistryBackup | null> {
  const path = join(dir, name)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) return null
  const { source, targeted } = classifyBackupName(name)
  const backup: RegistryBackup = {
    name,
    source,
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    keys: [],
    keyCount: 0,
    restorable: false,
    requiresAdmin: false
  }
  try {
    if (!targeted || info.size > MAX_TARGETED_BYTES) {
      backup.keys = await readFirstKey(path)
      backup.blocked = targeted ? 'too-large' : 'full-export'
    } else {
      const buf = await readFile(path)
      const assessment = assessRegistryBackup(
        name,
        buf,
        seals.get(name.toLowerCase()) === sha256Hex(buf)
      )
      backup.keys = assessment.keys
      backup.requiresAdmin = assessment.requiresAdmin
      backup.blocked = assessment.blocked
      backup.restorable = !assessment.blocked
    }
  } catch {
    backup.blocked = 'unreadable'
  }
  backup.keyCount = backup.keys.length
  backup.keys = backup.keys.slice(0, MAX_KEYS_SHOWN)
  return backup
}

/** Names of the Kudu backups that are regular files directly in `dir` (no links). */
async function backupFileNames(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((f) => f.isFile() && BACKUP_NAME.test(f.name) && !f.name.includes('..'))
    .map((f) => f.name)
}

/**
 * List Kudu-made registry backups in the backup folder, newest first, dropping
 * the seals of backups that no longer exist. Windows only.
 */
export async function listRegistryBackups(): Promise<RegistryBackup[]> {
  if (process.platform !== 'win32') return []
  const dir = getBackupDir()
  // Seals are read before the folder is listed; see `sweepSeals`.
  const sealsBefore = await readSeals()
  let names: string[]
  try {
    names = await backupFileNames(dir)
  } catch (error: any) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const seals = await sweepSeals(sealsBefore, new Set(names.map((n) => n.toLowerCase())))
  const backups: RegistryBackup[] = []
  for (const name of names) {
    const backup = await describeBackup(dir, name, seals).catch(() => null)
    if (backup) backups.push(backup)
  }
  return backups.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, MAX_LISTED)
}

/**
 * Resolve a renderer-supplied backup name to a regular file directly inside the
 * backup folder. The folder itself may be a junction (e.g. a redirected
 * Documents), so containment is checked on real paths; the file must not be a link.
 */
export async function resolveBackupFile(name: unknown): Promise<{ dir: string; path: string }> {
  if (typeof name !== 'string' || !BACKUP_NAME.test(name) || name.includes('..'))
    throw new Error('Invalid backup name')
  const dir = getBackupDir()
  const path = join(dir, name)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Backup is not a regular file')
  const [realDir, realFile] = await Promise.all([realpath(dir), realpath(path)])
  if (relative(realDir, dirname(realFile)) !== '')
    throw new Error('Backup is outside the backup folder')
  return { dir, path: realFile }
}

function shortKey(key: string): string {
  const idx = key.indexOf('\\')
  return SHORT_HIVES[key.slice(0, idx).toUpperCase()] + key.slice(idx)
}

/** A key to look up, and the value names under it whose presence matters. */
type KeyProbe = { key: string; names: string[] }
/** What a key holds right now: whether it exists, and which of the probed names it has. */
type KeyState = { exists: boolean; present: Set<string> }

/**
 * Windows caps a process command line at 32,767 characters, and the keys and
 * value names travel inside the -Command argument. Checking them in batches
 * keeps each invocation well under that limit however many a backup holds.
 */
const PROBE_PAYLOAD_BUDGET = 16_000
/** base64 cost of one item's JSON framing (`{"k":,"n":[]},`), rounded up. */
const PROBE_ITEM_OVERHEAD = 24

/** base64 length of a JSON string, plus its separator. */
function probeCost(text: string): number {
  return Math.ceil(((Buffer.byteLength(JSON.stringify(text), 'utf8') + 1) * 4) / 3)
}

/**
 * Split probes into batches that fit the budget. A key with more value names
 * than one batch can carry is split across batches, repeating the key.
 */
function batchKeyProbes(probes: KeyProbe[]): KeyProbe[][] {
  const batches: KeyProbe[][] = []
  let batch: KeyProbe[] = []
  let size = 0
  const flush = (): void => {
    if (batch.length) batches.push(batch)
    batch = []
    size = 0
  }
  for (const probe of probes) {
    const keyCost = PROBE_ITEM_OVERHEAD + probeCost(probe.key)
    if (batch.length && size + keyCost > PROBE_PAYLOAD_BUDGET) flush()
    let item: KeyProbe = { key: probe.key, names: [] }
    batch.push(item)
    size += keyCost
    for (const name of probe.names) {
      const cost = probeCost(name)
      if (size + cost > PROBE_PAYLOAD_BUDGET && (batch.length > 1 || item.names.length > 0)) {
        flush()
        item = { key: probe.key, names: [] }
        batch.push(item)
        size += keyCost
      }
      item.names.push(name)
      size += cost
    }
  }
  flush()
  return batches
}

/**
 * Which keys exist right now and which of the given value names they hold, via
 * .NET so a missing key is told apart from an unreadable one (reg.exe exits 1
 * for both). Access errors reject. Results are keyed by upper-cased key.
 */
async function probeKeys(probes: KeyProbe[]): Promise<Map<string, KeyState>> {
  const states = new Map<string, KeyState>()
  for (const batch of batchKeyProbes(probes)) {
    const answers = await probeKeysBatch(batch)
    batch.forEach((item, i) => {
      const upper = item.key.toUpperCase()
      const state = states.get(upper) ?? { exists: false, present: new Set<string>() }
      const answer = answers[i]!
      state.exists = answer[0] === '1'
      item.names.forEach((name, j) => {
        if (answer[j + 1] === '1') state.present.add(name.toLowerCase())
      })
      states.set(upper, state)
    })
  }
  return states
}

/**
 * One PowerShell run. Each item answers as a string: '1'/'0' for whether the
 * key exists, then one '1'/'0' per probed value name ('' is the default value).
 */
async function probeKeysBatch(batch: KeyProbe[]): Promise<string[]> {
  // Keys and names travel as base64 JSON so none is ever parsed as PowerShell.
  const items = batch.map((p) => ({ k: p.key, n: p.names }))
  const payload = Buffer.from(JSON.stringify(items), 'utf8').toString('base64')
  const script =
    "$ErrorActionPreference='Stop'; $r=@(); " +
    `foreach ($p in ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json)) { ` +
    '$i=$p.k.IndexOf([char]92); $h=$p.k.Substring(0,$i).ToUpperInvariant(); ' +
    "$b=switch ($h) { 'HKEY_LOCAL_MACHINE' { [Microsoft.Win32.Registry]::LocalMachine } 'HKEY_CURRENT_USER' { [Microsoft.Win32.Registry]::CurrentUser } 'HKEY_CLASSES_ROOT' { [Microsoft.Win32.Registry]::ClassesRoot } default { throw 'Unsupported hive' } }; " +
    '$n=@($p.n | Where-Object { $null -ne $_ }); ' +
    "$k=$b.OpenSubKey($p.k.Substring($i+1)); if ($null -eq $k) { $r+=('0' + ('0' * $n.Count)); continue }; " +
    "$v=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase); " +
    'foreach ($x in $k.GetValueNames()) { [void]$v.Add($x) }; $k.Close(); ' +
    "$s='1'; foreach ($x in $n) { if ($v.Contains([string]$x)) { $s+='1' } else { $s+='0' } }; $r+=$s }; " +
    'ConvertTo-Json -Compress -InputObject @($r)'
  const { stdout } = await execTracked(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)],
    { timeout: 15000, windowsHide: true }
  )
  const answers: unknown = JSON.parse(stdout)
  if (
    !Array.isArray(answers) ||
    answers.length !== batch.length ||
    answers.some(
      (a, i) =>
        typeof a !== 'string' || !/^[01]+$/.test(a) || a.length !== batch[i]!.names.length + 1
    )
  )
    throw new Error('Could not check which registry keys exist')
  return answers as string[]
}

/**
 * Deletion entries that undo what importing `sections` adds: `[-KEY]` for each
 * key absent now (the topmost one of an absent branch covers the rest), and
 * `"name"=-` for each value absent now under a key that exists. `reg export`
 * cannot record an absence, so without these a pre-restore backup would leave
 * everything the restore added in place. Pure — exported for tests.
 */
export function buildTombstones(
  sections: RegSection[],
  state: Map<string, KeyState>,
  canDelete: (key: string) => boolean = () => false
): string {
  const keys = new Map<string, { key: string; names: Map<string, string> }>()
  for (const s of sections) {
    const upper = s.key.toUpperCase()
    const entry = keys.get(upper) ?? { key: s.key, names: new Map<string, string>() }
    for (const name of [...s.values, ...s.deletedValues])
      if (!entry.names.has(name.toLowerCase())) entry.names.set(name.toLowerCase(), name)
    keys.set(upper, entry)
  }
  const exists = (key: string): boolean => state.get(key.toUpperCase())?.exists === true
  const knownAbsent = (key: string): boolean => state.get(key.toUpperCase())?.exists === false
  // Importing a key also creates its missing parents, so delete from the highest
  // one that is absent now — as long as it may be deleted at all (`canDelete`).
  const highestAbsent = (key: string): string => {
    let top = key
    for (let p = parentKey(key); p && canDelete(p) && knownAbsent(p); p = parentKey(p)) top = p
    return top
  }
  const absent = topLevelKeys(
    [...keys.values()]
      .map((e) => e.key)
      .filter((k) => !exists(k))
      .map(highestAbsent)
  )
  let text = absent.map((key) => `[-${key}]\r\n\r\n`).join('')
  for (const { key, names } of keys.values()) {
    if (!exists(key)) continue
    const present = state.get(key.toUpperCase())!.present
    const missing = [...names.values()].filter((n) => !present.has(n.toLowerCase()))
    if (missing.length)
      text += `[${key}]\r\n` + missing.map((n) => `${regValueName(n)}=-\r\n`).join('') + '\r\n'
  }
  return text
}

/**
 * Save the current state of everything a restore will touch into one sealed
 * `pre-restore-backup-*` file, so the restore can itself be undone: an export of
 * every top-level key that exists, plus tombstones for keys and values the
 * restore will add. Any failure rejects before anything is imported. Returns the
 * file name, or null when there is nothing to record.
 */
async function createPreRestoreBackup(
  sourceName: string,
  assessment: BackupAssessment,
  dir: string,
  tempDir: string
): Promise<string | null> {
  const probes = new Map<string, KeyProbe>()
  for (const s of assessment.sections) {
    const probe = probes.get(s.key.toUpperCase()) ?? { key: s.key, names: [] }
    probe.names.push(...s.values, ...s.deletedValues)
    probes.set(s.key.toUpperCase(), probe)
  }
  // Parents the import would create if missing, up to (never including) a scope
  // or branch root.
  const canDelete = (key: string) => isDeletableAncestor(key, scopesFor(sourceName))
  for (const s of assessment.sections) {
    for (let p = parentKey(s.key); p && canDelete(p); p = parentKey(p)) {
      if (!probes.has(p.toUpperCase())) probes.set(p.toUpperCase(), { key: p, names: [] })
    }
  }
  const state = await probeKeys([...probes.values()])
  const present = assessment.keys.filter((k) => state.get(k.toUpperCase())?.exists)
  const bodies: string[] = []
  for (let i = 0; i < present.length; i++) {
    const part = join(tempDir, `pre-${i}.reg`)
    try {
      await execNativeUtf8('reg', ['export', shortKey(present[i]!), part, '/y'], {
        timeout: 60000,
        windowsHide: true
      })
      const buf = await readFile(part)
      if (!parseRegExport(buf).ok) throw new Error('unexpected export format')
      bodies.push(
        buf.toString('utf16le', 2).replace(/^Windows Registry Editor Version 5\.00\r\n\r\n/, '')
      )
    } catch (error) {
      throw new Error(
        `Could not back up ${present[i]} before restoring, so nothing was imported: ${error instanceof Error ? error.message : error}`,
        { cause: error }
      )
    }
  }
  const tombstones = buildTombstones(assessment.sections, state, canDelete)
  if (!bodies.length && !tombstones) return null
  const name = `pre-restore-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.reg`
  const text = REG_HEADER + '\r\n\r\n' + bodies.join('') + tombstones
  const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  // The snapshot is only a safety net if Kudu will restore it later. Keys that
  // have grown past the targeted limits since the original backup would make
  // it unrestorable, so refuse the restore instead of importing without one.
  const blocked =
    body.length > MAX_TARGETED_BYTES ? 'too-large' : assessRegistryBackup(name, body, true).blocked
  if (blocked) {
    throw new Error(
      `The current state of these keys could not be saved as a restorable backup (${BLOCK_MESSAGES[blocked]}), so nothing was imported.`
    )
  }
  // Write, then seal: a seal must never exist before its file (see `sweepSeals`).
  try {
    await writeFile(join(dir, name), body, { flag: 'wx' })
  } catch (error) {
    throw new Error(
      `Could not save the pre-restore backup, so nothing was imported: ${error instanceof Error ? error.message : error}`,
      { cause: error }
    )
  }
  if (!(await sealBackup(name, body))) {
    await rm(join(dir, name), { force: true }).catch(() => {})
    throw new Error(
      'Could not record the integrity seal for the pre-restore backup, so nothing was imported. Relaunch Kudu as administrator.'
    )
  }
  await prunePreRestoreBackups(dir, name)
  return name
}

const PRE_RESTORE_BACKUPS_KEPT = 5

/**
 * Keep only the newest pre-restore backups, and drop the seals of those
 * removed; timestamped names sort chronologically. The snapshot just taken
 * (`current`) is always kept, even if the clock moved backwards and older files
 * carry later timestamps.
 */
async function prunePreRestoreBackups(dir: string, current: string): Promise<void> {
  try {
    const old = (await readdir(dir))
      .filter((f) => PRE_RESTORE.test(f) && f !== current)
      .sort()
      .reverse()
      .slice(PRE_RESTORE_BACKUPS_KEPT - 1)
    const removed: string[] = []
    for (const f of old) {
      await rm(join(dir, f), { force: true })
      removed.push(f)
    }
    await removeSeals(removed)
  } catch {
    // Best effort: a leftover backup or seal is harmless.
  }
}

const BLOCK_MESSAGES: Record<RegistryBackupBlock, string> = {
  'full-export':
    'This is a full-branch export. Importing it would roll back unrelated changes made since, so Kudu will not restore it.',
  'too-large': 'This backup is too large to be a targeted backup, so Kudu will not restore it.',
  format: 'This file is not a registry export in the format Kudu writes.',
  deletion: 'This file deletes registry data, which Kudu backups never do.',
  'forbidden-key': 'This file contains keys outside the areas Kudu changes.',
  empty: 'This backup contains no registry keys.',
  unreadable: 'This backup could not be read.',
  unverified:
    "This backup can't be verified — it may have been changed since Kudu wrote it, so Kudu will not restore it."
}

const ADMIN_REQUIRED =
  'Restoring a registry backup requires administrator privileges. Relaunch Kudu as administrator.'

let restoring = false

/**
 * Import a targeted backup: check its bytes against the seal recorded in HKLM,
 * validate them, save a sealed pre-restore backup of everything it touches, then
 * `reg import` a private copy of exactly the bytes that were checked.
 */
export async function restoreRegistryBackup(name: unknown): Promise<RegistryRestoreResult> {
  if (process.platform !== 'win32')
    throw new Error('Registry backups are only available on Windows')
  // Every restore needs elevation, whatever hive it writes: the pre-restore
  // backup must be sealed in HKLM and the work happens in an admin-only folder.
  if (!isAdmin()) throw new Error(ADMIN_REQUIRED)
  if (restoring) throw new Error('A registry restore is already running')
  restoring = true
  try {
    // Seals are read before the folder is listed; see `sweepSeals`.
    const sealsBefore = await readSeals()
    const { dir, path } = await resolveBackupFile(name)
    const fileName = name as string
    if (!classifyBackupName(fileName).targeted) throw new Error(BLOCK_MESSAGES['full-export'])
    if ((await lstat(path)).size > MAX_TARGETED_BYTES) throw new Error(BLOCK_MESSAGES['too-large'])
    const present = new Set((await backupFileNames(dir)).map((n) => n.toLowerCase()))
    const seals = await sweepSeals(sealsBefore, present)
    const buf = await readFile(path)
    const sealed = seals.get(fileName.toLowerCase()) === sha256Hex(buf)
    const assessment = assessRegistryBackup(fileName, buf, sealed)
    if (assessment.blocked) throw new Error(BLOCK_MESSAGES[assessment.blocked])
    // Exports and the import copy live where unelevated processes cannot rewrite them.
    let tempDir: string
    try {
      tempDir = await createPrivateTempDir('kudu-reg-restore-')
    } catch (error) {
      throw new Error(
        `Could not prepare a private working folder, so nothing was imported: ${error instanceof Error ? error.message : error}`,
        { cause: error }
      )
    }
    try {
      const preRestoreBackup = await createPreRestoreBackup(fileName, assessment, dir, tempDir)
      // Import a private copy so the file cannot change between validation and import.
      const importPath = join(tempDir, 'restore.reg')
      await writeFile(importPath, buf, { flag: 'wx' })
      try {
        await execNativeUtf8('reg', ['import', importPath], { timeout: 120000, windowsHide: true })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(
          preRestoreBackup
            ? `Import failed (${detail}). The previous state was saved to ${preRestoreBackup}.`
            : `Import failed (${detail}).`,
          { cause: error }
        )
      }
      return { name: fileName, keys: assessment.keys, preRestoreBackup }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    restoring = false
  }
}
