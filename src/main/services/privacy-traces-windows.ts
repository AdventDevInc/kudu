import { mkdir, readdir, stat, unlink } from 'fs/promises'
import { basename, join } from 'path'
import { getBackupDir } from './backup-dir'
import { execNativeUtf8 } from './exec-utf8'
import {
  deletingTrace,
  listTraceFiles,
  TraceSkipped,
  type PrivacyTrace,
  type PrivacyTraceGroup,
  type TraceScanContext
} from './privacy-traces'

/*
 * Windows activity traces. Deliberately out of scope, because clearing them
 * would cost the user more than the trace itself or they belong to a live
 * Windows service:
 *
 * - Jump lists (Recent\AutomaticDestinations, Recent\CustomDestinations):
 *   they also hold the user's pinned items.
 * - ShellBags: mixed with each folder's saved view settings.
 * - UserAssist: program launch counters which feed the Start menu.
 * - Timeline (ActivitiesCache.db): locked and synced by the Connected Devices
 *   Platform service.
 * - Recall snapshots and clipboard history: managed by Windows, each with its
 *   own clear option in Settings.
 */

const LNK = /\.lnk$/i

/** Direct `*.lnk` children only; never descends into the jump list folders. */
async function shortcutGroup(
  dir: string,
  subcategory: string,
  descriptionKey: string
): Promise<PrivacyTraceGroup[]> {
  const files = await listTraceFiles(dir, LNK)
  if (files.length === 0) return []
  return [{ subcategory, descriptionKey, traces: files.map((f) => deletingTrace(f.path, f.info)) }]
}

/** Recent items and Office recent-file shortcuts. */
export async function findWindowsRecentTraces(ctx: TraceScanContext): Promise<PrivacyTraceGroup[]> {
  if (ctx.platform !== 'win32') return []
  const appData = ctx.env.APPDATA || join(ctx.home, 'AppData', 'Roaming')
  return [
    ...(await shortcutGroup(
      join(appData, 'Microsoft', 'Windows', 'Recent'),
      'Recent items',
      'privacyRecentItemsNote'
    )),
    ...(await shortcutGroup(
      join(appData, 'Microsoft', 'Office', 'Recent'),
      'Office recent files',
      'privacyOfficeRecentNote'
    ))
  ]
}

// ── Registry most-recently-used lists ──

export interface MruList {
  subcategory: string
  descriptionKey: string
  /** HKCU key which holds the list. Never deleted itself. */
  key: string
  /** Value names which are list entries. */
  entry: RegExp
  /** Registry types a list entry may have; anything else is left alone. */
  entryTypes: string[]
  /** The ordering value (MRUList or MRUListEx), removed with the entries. */
  order?: { name: RegExp; type: string }
  /** Whether direct subkeys are per-file-type sub-lists to remove as well. */
  subkeyLists: boolean
}

const EXPLORER = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer'
const MRU_LIST = { name: /^MRUList$/i, type: 'REG_SZ' }
const MRU_LIST_EX = { name: /^MRUListEx$/i, type: 'REG_BINARY' }
const REGISTRY_NOTE = 'privacyRegistryListNote'

export const MRU_LISTS: MruList[] = [
  {
    subcategory: 'Recent documents list',
    descriptionKey: REGISTRY_NOTE,
    key: `${EXPLORER}\\RecentDocs`,
    entry: /^\d+$/,
    entryTypes: ['REG_BINARY'],
    order: MRU_LIST_EX,
    subkeyLists: true
  },
  {
    subcategory: 'Run dialog history',
    descriptionKey: REGISTRY_NOTE,
    key: `${EXPLORER}\\RunMRU`,
    entry: /^[a-z]$/i,
    entryTypes: ['REG_SZ'],
    order: MRU_LIST,
    subkeyLists: false
  },
  {
    subcategory: 'File Explorer address bar history',
    descriptionKey: REGISTRY_NOTE,
    key: `${EXPLORER}\\TypedPaths`,
    entry: /^url\d+$/i,
    entryTypes: ['REG_SZ', 'REG_EXPAND_SZ'],
    subkeyLists: false
  },
  {
    subcategory: 'File Explorer search history',
    descriptionKey: REGISTRY_NOTE,
    key: `${EXPLORER}\\WordWheelQuery`,
    entry: /^\d+$/,
    entryTypes: ['REG_BINARY'],
    order: MRU_LIST_EX,
    subkeyLists: false
  },
  {
    subcategory: 'Open/Save dialog history',
    descriptionKey: REGISTRY_NOTE,
    key: `${EXPLORER}\\ComDlg32\\OpenSavePidlMRU`,
    entry: /^\d+$/,
    entryTypes: ['REG_BINARY'],
    order: MRU_LIST_EX,
    subkeyLists: true
  },
  {
    subcategory: 'Open/Save dialog recent folders',
    descriptionKey: REGISTRY_NOTE,
    key: `${EXPLORER}\\ComDlg32\\LastVisitedPidlMRU`,
    entry: /^\d+$/,
    entryTypes: ['REG_BINARY'],
    order: MRU_LIST_EX,
    subkeyLists: false
  },
  {
    subcategory: 'Map Network Drive history',
    descriptionKey: REGISTRY_NOTE,
    key: `${EXPLORER}\\Map Network Drive MRU`,
    entry: /^[a-z]$/i,
    entryTypes: ['REG_SZ'],
    order: MRU_LIST,
    subkeyLists: false
  },
  {
    // Only the MRU0..MRU9 values. Saved usernames and certificate hints live
    // under Terminal Server Client\Servers, which this never touches.
    subcategory: 'Remote Desktop connection history',
    descriptionKey: 'privacyRdpHistoryNote',
    key: 'HKCU\\Software\\Microsoft\\Terminal Server Client\\Default',
    entry: /^MRU\d$/i,
    entryTypes: ['REG_SZ'],
    subkeyLists: false
  }
]

export interface RegValue {
  name: string
  type: string
}

export interface RegKey {
  /** Short-form path (HKCU\...) with key names exactly as reg.exe printed them. */
  path: string
  values: RegValue[]
}

/** Keys in `reg query /s` output, by lower-cased short-form path. */
export type RegListing = Map<string, RegKey>

const HIVES: Record<string, string> = {
  HKEY_CURRENT_USER: 'HKCU',
  HKEY_LOCAL_MACHINE: 'HKLM',
  HKEY_CLASSES_ROOT: 'HKCR',
  HKEY_USERS: 'HKU',
  HKEY_CURRENT_CONFIG: 'HKCC'
}

function shortForm(key: string): string {
  const hive = key.split('\\', 1)[0]
  const alias = HIVES[hive.toUpperCase()]
  return alias ? alias + key.slice(hive.length) : key
}

// Value lines are `    <name>    <REG_TYPE>    <data>`. Key paths, value names
// and the REG_* type tokens are never localised, but the label of the unnamed
// default value is (`(Default)`, `(Standard)`, `(par défaut)`, ...), so it can
// never match an entry pattern and is never removed.
const VALUE_LINE = /^ {4}(.+?) {4}(REG_[A-Z0-9_]+)(?: {4}.*)?$/
const KEY_LINE = /^HKEY_[A-Z_]+(\\|$)/

/** Parse `reg query <key> /s` output. Data is ignored; only names and types matter. */
export function parseRegQuery(stdout: string): RegListing {
  const listing: RegListing = new Map()
  let current: RegKey | null = null
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line) continue
    if (KEY_LINE.test(line)) {
      current = { path: shortForm(line), values: [] }
      listing.set(current.path.toLowerCase(), current)
      continue
    }
    const match = VALUE_LINE.exec(line)
    if (match && current) current.values.push({ name: match[1], type: match[2] })
  }
  return listing
}

export interface MruPlan {
  /** Entry value names directly under the list key. */
  entries: string[]
  /** Full paths of direct subkeys which are sub-lists. */
  subkeys: string[]
  /** The ordering value, removed last. Empty when there is nothing else to clear. */
  order: string[]
  /** Approximate number of remembered items. */
  entryCount: number
}

function isEntry(list: MruList, value: RegValue): boolean {
  return list.entry.test(value.name) && list.entryTypes.includes(value.type)
}

function isOrder(list: MruList, value: RegValue): boolean {
  return !!list.order && list.order.name.test(value.name) && value.type === list.order.type
}

/** Work out exactly what clearing `list` removes. Pure; exported for tests. */
export function planMruClear(list: MruList, listing: RegListing): MruPlan {
  const root = shortForm(list.key).toLowerCase()
  const rootValues = listing.get(root)?.values ?? []
  const entries = rootValues.filter((v) => isEntry(list, v)).map((v) => v.name)

  const subkeys: string[] = []
  let subEntries = 0
  if (list.subkeyLists) {
    for (const [lower, key] of listing) {
      const name = lower.startsWith(root + '\\') ? lower.slice(root.length + 1) : ''
      if (!name || name.includes('\\')) continue
      // A sub-list holds nothing but MRU values and has no children of its
      // own. Anything else under the list key is left alone.
      const count = key.values.filter((v) => isEntry(list, v)).length
      const onlyMru = key.values.every((v) => isEntry(list, v) || isOrder(list, v))
      const nested = [...listing.keys()].some((k) => k.startsWith(lower + '\\'))
      if (count === 0 || !onlyMru || nested) continue
      subkeys.push(key.path)
      subEntries = Math.max(subEntries, count)
    }
  }
  const found = entries.length > 0 || subkeys.length > 0
  return {
    entries,
    subkeys,
    order: found ? rootValues.filter((v) => isOrder(list, v)).map((v) => v.name) : [],
    entryCount: Math.max(entries.length, subEntries)
  }
}

function isEmptyPlan(plan: MruPlan): boolean {
  return plan.entries.length === 0 && plan.subkeys.length === 0
}

async function queryList(list: MruList): Promise<string | null> {
  try {
    const { stdout } = await execNativeUtf8('reg', ['query', list.key, '/s'], {
      timeout: 15000,
      // Open/Save dialog sub-lists hold binary PIDLs and can exceed the 1 MB default.
      maxBuffer: 32 * 1024 * 1024
    })
    return stdout
  } catch {
    // Missing key (reg exits 1) or no access: nothing to report.
    return null
  }
}

const BACKUP_PREFIX = 'privacy-traces-backup-'
const BACKUPS_KEPT_PER_LIST = 3

function backupSlug(list: MruList): string {
  const leaf = list.key.slice(list.key.lastIndexOf('\\') + 1)
  return leaf.replace(/[^A-Za-z0-9]+/g, '-')
}

/** Keep only the newest backups of one list: they hold the very history being cleared. */
async function pruneBackups(dir: string, slug: string, current: string): Promise<void> {
  try {
    const prefix = `${BACKUP_PREFIX}${slug}-`
    // The backup just taken is always kept, even if the clock went backwards
    // and older files carry later timestamps: it guards the clear about to run.
    const files = (await readdir(dir))
      .filter((f) => f.startsWith(prefix) && f.endsWith('.reg') && f !== current)
      .sort()
      .reverse()
    for (const f of files.slice(BACKUPS_KEPT_PER_LIST - 1))
      await unlink(join(dir, f)).catch(() => {})
  } catch {
    /* best effort */
  }
}

/** Export the whole list key to a .reg file in the Kudu backup folder; throws unless written. */
export async function backupMruList(list: MruList): Promise<string> {
  const dir = getBackupDir()
  const slug = backupSlug(list)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${BACKUP_PREFIX}${slug}-${timestamp}.reg`)
  try {
    await mkdir(dir, { recursive: true })
    await execNativeUtf8('reg', ['export', list.key, file, '/y'], { timeout: 30000 })
    if ((await stat(file)).size === 0) throw new Error('empty backup')
  } catch {
    // An empty or partial export must not count as one of the kept backups.
    await unlink(file).catch(() => {})
    throw new TraceSkipped('registry backup failed, nothing was changed')
  }
  await pruneBackups(dir, slug, basename(file))
  return file
}

/**
 * Clear one list: re-read it, back it up, then remove only the planned values
 * and sub-lists. The list key itself is never deleted, and nothing is removed
 * unless the backup succeeded.
 */
export async function clearMruList(list: MruList): Promise<number> {
  const stdout = await queryList(list)
  if (stdout === null) throw new TraceSkipped('not-found')
  const plan = planMruClear(list, parseRegQuery(stdout))
  if (isEmptyPlan(plan)) return 0

  await backupMruList(list)

  let failures = 0
  const reg = async (args: string[]) => {
    try {
      await execNativeUtf8('reg', args, { timeout: 10000 })
    } catch {
      failures++
    }
  }
  // Entries and sub-lists first, the ordering value last, so an interrupted
  // clear leaves an ordering value Explorer rebuilds rather than stray entries.
  for (const name of plan.entries) await reg(['delete', list.key, '/v', name, '/f'])
  for (const subkey of plan.subkeys) await reg(['delete', subkey, '/f'])
  for (const name of plan.order) await reg(['delete', list.key, '/v', name, '/f'])
  if (failures > 0) {
    throw new TraceSkipped(`${failures} entries could not be removed; a backup was saved`)
  }
  return 0
}

/** Registry MRU lists with at least one entry, one group per list. */
export async function findWindowsRegistryTraces(
  ctx: TraceScanContext
): Promise<PrivacyTraceGroup[]> {
  if (ctx.platform !== 'win32') return []
  const groups: PrivacyTraceGroup[] = []
  for (const list of MRU_LISTS) {
    const stdout = await queryList(list)
    if (stdout === null) continue
    const plan = planMruClear(list, parseRegQuery(stdout))
    if (isEmptyPlan(plan)) continue
    const trace: PrivacyTrace = {
      path: list.key,
      size: 0,
      lastModified: 0,
      entryCount: plan.entryCount,
      clean: () => clearMruList(list)
    }
    groups.push({
      subcategory: list.subcategory,
      descriptionKey: list.descriptionKey,
      traces: [trace]
    })
  }
  return groups
}
