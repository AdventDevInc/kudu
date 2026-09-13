import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  validateRecoveryEntry,
  type RecoveryEntry,
  type RecoveryTarget,
  type RecoveryValue
} from '../../shared/recovery'

const directory = () =>
  join(app.getPath('userData'), app.isPackaged ? 'recovery' : 'Kudu-Dev/recovery')
let writes: Promise<unknown> = Promise.resolve()
const file = () => join(directory(), 'changes.json')
interface SealedEntry {
  id: string
  body: string
}
async function readSealed(): Promise<SealedEntry[]> {
  try {
    const entries: unknown = JSON.parse(await readFile(file(), 'utf8'))
    if (
      !Array.isArray(entries) ||
      entries.length > 5000 ||
      entries.some(
        (e) =>
          !e ||
          typeof e.id !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(e.id) ||
          typeof e.body !== 'string' ||
          e.body.length > 32768
      ) ||
      new Set(entries.map((e) => e.id)).size !== entries.length
    )
      throw new Error('Invalid recovery store')
    return entries
  } catch (error: any) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}
function unseal(record: SealedEntry): RecoveryEntry {
  const entry: unknown = JSON.parse(safeStorage.decryptString(Buffer.from(record.body, 'base64')))
  if (!validateRecoveryEntry(entry) || entry.id !== record.id)
    throw new Error('Invalid recovery record')
  return entry
}
let warnedUnreadable = false
/** Unseal what can be read; corrupt or undecryptable records are reported by ID, not thrown. */
function unsealReadable(records: SealedEntry[]) {
  const entries: RecoveryEntry[] = []
  const unreadable: string[] = []
  for (const record of records) {
    try {
      entries.push(unseal(record))
    } catch {
      unreadable.push(record.id)
    }
  }
  if (unreadable.length && !warnedUnreadable) {
    warnedUnreadable = true
    console.warn(`[recovery] ${unreadable.length} recovery record(s) could not be read`)
  }
  return { entries, unreadable }
}
export async function listRecoveryPage(offset: number) {
  await writes
  const records = await readSealed()
  return { ...unsealReadable(records.slice(offset, offset + 50)), total: records.length }
}
export async function getRecoveryEntry(id: string) {
  await writes
  const record = (await readSealed()).find((e) => e.id === id)
  return record ? unseal(record) : undefined
}
export async function listRecoveryEntries(): Promise<RecoveryEntry[]> {
  await writes
  const records = await readSealed()
  const entries: RecoveryEntry[] = []
  for (let i = 0; i < records.length; i += 10) {
    entries.push(...unsealReadable(records.slice(i, i + 10)).entries)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return entries
}
async function writeSealed(entries: SealedEntry[]) {
  await mkdir(directory(), { recursive: true })
  await writeFile(file() + '.tmp', JSON.stringify(entries), 'utf8')
  await rename(file() + '.tmp', file())
}
function enqueue(action: () => Promise<void>): Promise<void> {
  const pending = writes.then(action)
  writes = pending.catch(() => {})
  return pending
}
/** Remove any entry that is not mid-change; unreadable records are removed without unsealing. */
export async function removeRecoveryEntry(id: unknown): Promise<void> {
  if (typeof id !== 'string') throw new Error('Invalid recovery ID')
  await enqueue(async () => {
    const entries = await readSealed()
    const record = entries.find((e) => e.id === id)
    if (!record) throw new Error('Recovery entry not found')
    let status: RecoveryEntry['status'] | undefined
    try {
      status = unseal(record).status
    } catch {
      status = undefined
    }
    if (status === 'pending') throw new Error('Pending entries cannot be removed')
    await writeSealed(entries.filter((e) => e.id !== id))
  })
}
async function save(entry: RecoveryEntry): Promise<void> {
  if (!validateRecoveryEntry(entry)) throw new Error('Invalid recovery entry')
  await enqueue(async () => {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('Secure recovery storage is unavailable')
    const entries = await readSealed()
    const index = entries.findIndex((e) => e.id === entry.id)
    const sealed = {
      id: entry.id,
      body: safeStorage.encryptString(JSON.stringify(entry)).toString('base64')
    }
    if (index >= 0) entries[index] = sealed
    else {
      if (entries.length >= 5000)
        throw new Error('Recovery storage is full; remove completed entries first')
      entries.unshift(sealed)
    }
    await writeSealed(entries)
  })
}
export async function recordRecoveryChange(
  source: RecoveryEntry['source'],
  label: string,
  target: RecoveryTarget,
  before: RecoveryValue,
  after: RecoveryValue,
  apply: () => Promise<void>,
  readAfter?: () => Promise<RecoveryValue>
): Promise<void> {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    await apply()
    return
  }
  const timestamp = new Date().toISOString()
  const entry: RecoveryEntry = {
    version: 1,
    id: randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
    source,
    label,
    target,
    before,
    after,
    status: 'pending'
  }
  if (!validateRecoveryEntry(entry)) throw new Error('Unsupported recovery target')
  await save(entry)
  try {
    await apply()
    entry.status = 'ready'
    // The change applied; a failed after-read keeps the predicted `after` rather than
    // reporting the change itself as failed.
    if (readAfter) {
      try {
        entry.after = await readAfter()
      } catch (error) {
        console.warn('[recovery] could not read state after change:', error)
      }
    }
  } catch (error) {
    entry.status = 'failed'
    entry.error = 'The change did not complete. Inspect its current state before restoring.'
    entry.updatedAt = new Date().toISOString()
    // Never let a journal write failure mask the primary error from apply().
    await save(entry).catch((saveError) =>
      console.warn('[recovery] could not update journal after failed change:', saveError)
    )
    throw error
  }
  entry.updatedAt = new Date().toISOString()
  await save(entry)
}
export interface RecoveryChange {
  label: string
  target: RecoveryTarget
  before: RecoveryValue
  after: RecoveryValue
}
/**
 * Journal several changes that one mutation applies together (for example a single
 * PowerShell run that reconfigures many services). Every entry is persisted as
 * pending before `apply` runs; afterwards each is marked ready or failed from the
 * per-change failure reasons `apply` returns (aligned with `changes`, undefined =
 * success). `readAfter` may replace the predicted after-states, aligned the same way;
 * a failed after-read keeps the prediction rather than reporting the change as failed.
 * Returns the per-change failure reasons; throws only when apply itself throws.
 */
export async function recordRecoveryChanges(
  source: RecoveryEntry['source'],
  changes: RecoveryChange[],
  apply: () => Promise<(string | undefined)[]>,
  readAfter?: () => Promise<(RecoveryValue | undefined)[]>
): Promise<(string | undefined)[]> {
  const timestamp = new Date().toISOString()
  const entries = changes.map((change) => {
    if (JSON.stringify(change.before) === JSON.stringify(change.after)) return undefined
    const entry: RecoveryEntry = {
      version: 1,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp,
      source,
      ...change,
      status: 'pending'
    }
    if (!validateRecoveryEntry(entry)) throw new Error('Unsupported recovery target')
    return entry
  })
  for (const entry of entries) if (entry) await save(entry)
  let failures: (string | undefined)[]
  try {
    failures = await apply()
  } catch (error) {
    for (const entry of entries) {
      if (!entry) continue
      entry.status = 'failed'
      entry.error = 'The change did not complete. Inspect its current state before restoring.'
      entry.updatedAt = new Date().toISOString()
      // Never let a journal write failure mask the primary error from apply().
      await save(entry).catch((saveError) =>
        console.warn('[recovery] could not update journal after failed change:', saveError)
      )
    }
    throw error
  }
  let afters: (RecoveryValue | undefined)[] = []
  if (readAfter && failures.some((reason, i) => !reason && entries[i])) {
    try {
      afters = await readAfter()
    } catch (error) {
      console.warn('[recovery] could not read state after change:', error)
    }
  }
  for (const [i, entry] of entries.entries()) {
    if (!entry) continue
    if (failures[i]) {
      entry.status = 'failed'
      entry.error = 'The change did not complete. Inspect its current state before restoring.'
    } else {
      entry.status = 'ready'
      if (afters[i] !== undefined) entry.after = afters[i]
    }
    entry.updatedAt = new Date().toISOString()
    await save(entry)
  }
  return failures
}
export async function updateRecoveryEntry(entry: RecoveryEntry): Promise<void> {
  if (!validateRecoveryEntry(entry)) throw new Error('Invalid recovery entry')
  await save({ ...entry, updatedAt: new Date().toISOString() })
}
