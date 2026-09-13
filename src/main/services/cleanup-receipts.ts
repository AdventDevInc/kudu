import { app } from 'electron'
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
  statfs
} from 'fs/promises'
import { join, parse } from 'path'
import { randomUUID } from 'crypto'
import type { CleanupReceipt, CleanupReceiptItem } from '../../shared/cleanup-receipts'
import { summarizeReceipt } from '../../shared/cleanup-receipts'
import type { CleanResult, DeletionOrigin, ScanItem } from '../../shared/types'
import { getSettings } from './settings-store'
import { countCachedCategories, getCachedItem } from './scan-cache'

const retryRuns = new Map<string, { expires: number; ids: string[] }>()
let writes: Promise<unknown> = Promise.resolve()
const directory = () =>
  join(app.getPath('userData'), app.isPackaged ? 'cleanup-receipts' : 'Kudu-Dev/cleanup-receipts')
const file = () => join(directory(), 'receipts.json')
const lockFile = () => join(directory(), 'receipts.lock')
const tempFile = (path: string) => path + '.' + randomUUID() + '.tmp'
const receiptFile = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid receipt ID')
  return join(directory(), id + '.json')
}
// Persist reason codes, not exception messages which can contain private paths.
const REASON_CODES = new Set([
  '',
  'scan-result-expired',
  'not-found',
  'excluded',
  'permission-denied',
  'in-use',
  'recently-modified',
  'local-selection-required',
  'native-maintenance-size-unknown',
  'partial-removal',
  'unexpected-error',
  'native-cleanup-failed'
])
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000
/** Live owners refresh the lock mtime well inside LOCK_STALE_MS so a slow task is never reclaimed. */
const LOCK_HEARTBEAT_MS = 10_000

/**
 * Serialize index updates across processes: the packaged GUI, the daemon, and `--cli` share one
 * user-data directory but have independent in-process write queues. The lock file holds a token
 * naming its owner, so a caller only ever releases its own lock. A lock left behind by a crashed
 * process is reclaimed once it is older than LOCK_STALE_MS; the reclaim renames it first, which is
 * atomic, so of two concurrent reclaimers only one succeeds and neither can delete a lock the other
 * has just re-acquired. While a task runs, a heartbeat keeps the lock fresh so a live owner on a slow
 * volume is not mistaken for a crashed one.
 */
async function withIndexLock<T>(task: () => Promise<T>): Promise<T> {
  await mkdir(directory(), { recursive: true })
  const token = randomUUID()
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = await open(lockFile(), 'wx')
      try {
        await handle.writeFile(token, 'utf8')
      } finally {
        await handle.close()
      }
      break
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error
      const age = await stat(lockFile())
        .then((info) => Date.now() - info.mtimeMs)
        .catch(() => 0)
      if (age > LOCK_STALE_MS) {
        await reclaimStaleLock()
        continue
      }
      if (Date.now() >= deadline)
        throw new Error('Cleanup receipt index is locked by another process', { cause: error })
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const heartbeat = setInterval(() => {
    void readFile(lockFile(), 'utf8')
      .then((owner) => {
        if (owner !== token) return
        const now = new Date()
        return utimes(lockFile(), now, now)
      })
      .catch(() => {})
  }, LOCK_HEARTBEAT_MS)
  try {
    return await task()
  } finally {
    clearInterval(heartbeat)
    // Defensive: never delete a lock that is no longer ours.
    const owner = await readFile(lockFile(), 'utf8').catch(() => undefined)
    if (owner === token) await unlink(lockFile()).catch(() => {})
  }
}

/** Move the stale lock aside atomically; the loser of a concurrent reclaim sees ENOENT and retries. */
async function reclaimStaleLock(): Promise<void> {
  const claimed = lockFile() + '.' + randomUUID() + '.stale'
  try {
    await rename(lockFile(), claimed)
  } catch (error: any) {
    if (error.code === 'ENOENT') return
    throw error
  }
  await unlink(claimed).catch(() => {})
}

/** Read the index, quarantining an unreadable one so a corrupt file cannot wedge the feature. */
async function readIndexOrQuarantine(): Promise<CleanupReceipt[]> {
  try {
    const parsed = JSON.parse(await readFile(file(), 'utf8'))
    if (!Array.isArray(parsed)) throw new Error('Invalid cleanup receipt store')
    return parsed
  } catch (error: any) {
    if (error.code === 'ENOENT') return []
    await rename(file(), file() + '.corrupt-' + Date.now())
    return []
  }
}

export async function getCleanupReceipt(id: string): Promise<CleanupReceipt> {
  await writes
  const receipt = JSON.parse(await readFile(receiptFile(id), 'utf8')) as CleanupReceipt
  if (receipt.version !== 1 || receipt.id !== id || !Array.isArray(receipt.details))
    throw new Error('Invalid cleanup receipt')
  return receipt
}

export async function getCleanupReceipts(): Promise<CleanupReceipt[]> {
  await writes
  try {
    const parsed = JSON.parse(await readFile(file(), 'utf8'))
    if (!Array.isArray(parsed)) throw new Error('Invalid cleanup receipt store')
    return parsed.filter((r) => r?.version === 1 && typeof r.id === 'string').slice(0, 100)
  } catch (error: any) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export function createReceipt(
  origin: DeletionOrigin,
  parentId?: string,
  selectedItems: ScanItem[] = []
) {
  const categories = new Set(selectedItems.map((i) => i.category))
  const meta = {
    id: randomUUID(),
    parentId,
    startedAt: new Date().toISOString(),
    origin,
    pathLogging: getSettings().cleaner.keepDeletionLog === true,
    found: categories.size ? countCachedCategories(categories) : undefined
  }
  const outcomes: CleanupReceiptItem[] = []
  const before = new Map<string, number>()
  return {
    id: meta.id,
    hasOutcome(id: string) {
      return outcomes.some((item) => item.id === id)
    },
    /** Reclassify a recorded failure once a later probe explains its cause (e.g. Windows EPERM). */
    updateReason(id: string, reason: string) {
      if (!REASON_CODES.has(reason)) reason = 'other-error'
      if (reason === 'in-use') reason = 'in-use-or-protected'
      for (const item of outcomes) {
        if (item.id === id && item.outcome === 'failed') item.reason = reason
      }
    },
    async measureVolumes() {
      // Windows drive roots remain available even after selected directories are removed.
      // Other platforms need mount identity discovery; omit rather than report the wrong volume.
      if (process.platform !== 'win32') return
      const roots = [
        ...new Set(selectedItems.filter((i) => !i.cleanupAction).map((i) => parse(i.path).root))
      ]
        .filter((root) => /^[a-z]:[\\/]$/i.test(root))
        .slice(0, 26)
      await Promise.all(
        roots.map(async (root) => {
          try {
            const info = await statfs(root)
            before.set(root, info.bavail * info.bsize)
          } catch {
            /* unavailable */
          }
        })
      )
    },
    add(
      item: ScanItem | string,
      outcome: CleanupReceiptItem['outcome'],
      reason = '',
      attempted = false,
      removedBytes = 0,
      selectedBytes?: number | null
    ) {
      if (!REASON_CODES.has(reason)) reason = 'other-error'
      if (reason === 'in-use') reason = 'in-use-or-protected'
      outcomes.push(
        typeof item === 'string'
          ? {
              id: item,
              category: 'Expired scan result',
              outcome,
              reason,
              attempted,
              selectedBytes: null,
              removedBytes
            }
          : {
              id: item.id,
              category: item.subcategory || item.category,
              path: item.path,
              outcome,
              reason,
              attempted,
              selectedBytes:
                selectedBytes === undefined
                  ? item.cleanupAction
                    ? null
                    : item.size
                  : selectedBytes,
              removedBytes
            }
      )
    },
    async finish() {
      const receipt = summarizeReceipt(meta, outcomes)
      receipt.volumeChanges = []
      for (const [volume, freeBefore] of before) {
        try {
          const info = await statfs(volume)
          const freeAfter = info.bavail * info.bsize
          receipt.volumeChanges.push({
            volume,
            freeBefore,
            freeAfter,
            delta: freeAfter - freeBefore
          })
        } catch {
          /* unavailable measurements are not zero */
        }
      }
      const now = Date.now()
      for (const [id, retry] of retryRuns) if (retry.expires < now) retryRuns.delete(id)
      retryRuns.set(meta.id, {
        expires: now + 30 * 60_000,
        ids: outcomes.filter((i) => i.outcome === 'failed' && getCachedItem(i.id)).map((i) => i.id)
      })
      while (retryRuns.size > 100) retryRuns.delete(retryRuns.keys().next().value!)
      const write = writes.then(() =>
        withIndexLock(async () => {
          const existing = await readIndexOrQuarantine()
          const detailPath = receiptFile(receipt.id)
          const detailTemp = tempFile(detailPath)
          await writeFile(detailTemp, JSON.stringify(receipt), 'utf8')
          await rename(detailTemp, detailPath)
          const temp = tempFile(file())
          await writeFile(
            temp,
            JSON.stringify([{ ...receipt, details: [] }, ...existing].slice(0, 100)),
            'utf8'
          )
          await rename(temp, file())
          for (const expired of existing.slice(99)) {
            await unlink(receiptFile(expired.id)).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error
            })
          }
        })
      )
      writes = write.catch(() => {})
      await write
      return receipt
    }
  }
}

/** Only server-owned, still-cached IDs can be retried; never accept caller paths. */
export function receiptRetryIds(id: string): string[] {
  const retry = retryRuns.get(id)
  if (!retry || retry.expires < Date.now()) return []
  return retry.ids.filter((itemId) => getCachedItem(itemId) !== undefined)
}

export async function clearCleanupReceipts(): Promise<void> {
  const write = writes.then(() =>
    withIndexLock(async () => {
      // Enumerate the directory rather than trusting the index so a corrupt or stale index
      // cannot strand detail files (which may contain logged paths) on disk.
      const owned =
        /^([a-f0-9-]{36}\.json(\.([a-f0-9-]{36}\.)?tmp)?|receipts\.json\.(([a-f0-9-]{36}\.)?tmp|corrupt-\d+)|receipts\.lock\.[a-f0-9-]{36}\.stale)$/
      for (const name of await readdir(directory()))
        if (owned.test(name))
          await unlink(join(directory(), name)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
      const temp = tempFile(file())
      await writeFile(temp, '[]', 'utf8')
      await rename(temp, file())
      retryRuns.clear()
    })
  )
  writes = write.catch(() => {})
  await write
}

/** Native operations have their own accounting units; never invent per-file outcomes. */
export async function recordNativeCleanup(
  label: string,
  operation: () => Promise<CleanResult>,
  origin: DeletionOrigin = 'local'
): Promise<CleanResult> {
  const receipt = createReceipt(origin)
  const item: ScanItem = {
    id: randomUUID(),
    path: label,
    category: label,
    subcategory: label + ' (native operation)',
    size: 0,
    selected: true,
    lastModified: 0
  }
  let result: CleanResult
  try {
    result = await operation()
  } catch (error) {
    receipt.add(item, 'failed', 'unexpected-error', true, 0, null)
    await receipt.finish().catch(() => {})
    throw error
  }
  if (result.receiptId) return result
  const failed = result.errors.length > 0 || result.filesSkipped > 0
  // Keep the native operation's actionable cause when it is an allow-listed code; only call the
  // outcome a partial removal when something was actually removed alongside the failures.
  const nativeReason =
    result.filesDeleted > 0
      ? 'partial-removal'
      : (result.errors.map((e) => e.reason).find((r) => r && REASON_CODES.has(r)) ??
        'native-cleanup-failed')
  receipt.add(
    item,
    failed ? 'failed' : 'deleted',
    failed ? nativeReason : '',
    true,
    result.totalCleaned,
    null
  )
  let receiptSaved = true
  try {
    await receipt.finish()
  } catch {
    receiptSaved = false
  }
  return { ...result, receiptId: receipt.id, receiptSaved }
}
