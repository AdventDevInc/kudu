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
export async function listRecoveryPage(offset: number) {
  await writes
  const records = await readSealed()
  return { entries: records.slice(offset, offset + 50).map(unseal), total: records.length }
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
  for (const record of records) {
    entries.push(unseal(record))
    if (entries.length % 10 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
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
export async function removeRestoredRecoveryEntry(id: unknown): Promise<void> {
  if (typeof id !== 'string') throw new Error('Invalid recovery ID')
  await enqueue(async () => {
    const entries = await readSealed()
    const record = entries.find((e) => e.id === id)
    if (!record || unseal(record).status !== 'restored')
      throw new Error('Only restored entries can be removed')
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
        throw new Error('Recovery storage is full; remove restored entries first')
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
    if (readAfter) entry.after = await readAfter()
    entry.status = 'ready'
  } catch (error) {
    entry.status = 'failed'
    entry.error = 'The change did not complete. Inspect its current state before restoring.'
    throw error
  } finally {
    entry.updatedAt = new Date().toISOString()
    await save(entry)
  }
}
export async function updateRecoveryEntry(entry: RecoveryEntry): Promise<void> {
  if (!validateRecoveryEntry(entry)) throw new Error('Invalid recovery entry')
  await save({ ...entry, updatedAt: new Date().toISOString() })
}
