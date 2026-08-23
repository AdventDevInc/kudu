import type { CleanResult } from '@shared/types'

export const CLEANER_BATCH_SIZE = 250_000

export interface BatchedCleanResult {
  result: CleanResult
  error?: unknown
}

/**
 * Clean a bounded sequence of IDs while retaining the accounting from every
 * batch that completed before a later IPC failure.
 */
export async function cleanInBatches(
  ids: string[],
  clean: (batch: string[]) => Promise<CleanResult>,
): Promise<BatchedCleanResult> {
  const result: CleanResult = {
    totalCleaned: 0,
    filesDeleted: 0,
    filesSkipped: 0,
    errors: [],
    needsElevation: false,
  }

  for (let offset = 0; offset < ids.length; offset += CLEANER_BATCH_SIZE) {
    try {
      const batch = await clean(ids.slice(offset, offset + CLEANER_BATCH_SIZE))
      result.totalCleaned += batch.totalCleaned || 0
      result.filesDeleted += batch.filesDeleted || 0
      result.filesSkipped += batch.filesSkipped || 0
      if (batch.errors?.length) result.errors.push(...batch.errors)
      if (batch.needsElevation) result.needsElevation = true
    } catch (error) {
      return { result, error }
    }
  }

  return { result }
}
