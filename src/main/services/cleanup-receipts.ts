import { app } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile, statfs } from 'fs/promises'
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
const receiptFile = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid receipt ID')
  return join(directory(), id + '.json')
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
      // Persist reason codes, not exception messages which can contain private paths.
      const allowed = new Set([
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
      if (!allowed.has(reason)) reason = 'other-error'
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
      const write = writes.then(async () => {
        await mkdir(directory(), { recursive: true })
        const existing = await readIndexOrQuarantine()
        const detailPath = receiptFile(receipt.id)
        await writeFile(detailPath + '.tmp', JSON.stringify(receipt), 'utf8')
        await rename(detailPath + '.tmp', detailPath)
        const temp = file() + '.tmp'
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
  const write = writes.then(async () => {
    await mkdir(directory(), { recursive: true })
    for (const entry of await readIndexOrQuarantine())
      if (typeof entry?.id === 'string')
        await unlink(receiptFile(entry.id)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
    await writeFile(file() + '.tmp', '[]', 'utf8')
    await rename(file() + '.tmp', file())
    retryRuns.clear()
  })
  writes = write.catch(() => {})
  await write
}

/** Native operations have their own accounting units; never invent per-file outcomes. */
export async function recordNativeCleanup(
  label: string,
  operation: () => Promise<CleanResult>
): Promise<CleanResult> {
  const receipt = createReceipt('local')
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
  receipt.add(
    item,
    result.errors.length || result.filesSkipped ? 'failed' : 'deleted',
    result.errors.length || result.filesSkipped ? 'partial-removal' : '',
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
