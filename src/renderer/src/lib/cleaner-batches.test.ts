import { describe, expect, it, vi } from 'vitest'
import type { CleanResult } from '@shared/types'
import { CLEANER_BATCH_SIZE, cleanInBatches } from './cleaner-batches'

function result(overrides: Partial<CleanResult> = {}): CleanResult {
  return {
    totalCleaned: 0,
    filesDeleted: 0,
    filesSkipped: 0,
    errors: [],
    needsElevation: false,
    ...overrides,
  }
}

describe('cleanInBatches', () => {
  it('splits oversized cleaner selections and aggregates every result', async () => {
    const clean = vi.fn()
      .mockResolvedValueOnce(result({ totalCleaned: 10, filesDeleted: 2 }))
      .mockResolvedValueOnce(result({
        totalCleaned: 20,
        filesDeleted: 1,
        filesSkipped: 1,
        errors: [{ path: 'C:\\protected.log', reason: 'permission-denied' }],
        needsElevation: true,
      }))
    const ids = Array.from({ length: CLEANER_BATCH_SIZE + 1 }, (_, index) => String(index))

    const cleaned = await cleanInBatches(ids, clean)

    expect(clean).toHaveBeenCalledTimes(2)
    expect(clean.mock.calls[0][0]).toHaveLength(CLEANER_BATCH_SIZE)
    expect(clean.mock.calls[1][0]).toHaveLength(1)
    expect(cleaned).toEqual({
      result: result({
        totalCleaned: 30,
        filesDeleted: 3,
        filesSkipped: 1,
        errors: [{ path: 'C:\\protected.log', reason: 'permission-denied' }],
        needsElevation: true,
      }),
    })
  })

  it('preserves successful batch accounting when a later call fails', async () => {
    const failure = new Error('IPC rejected batch')
    const clean = vi.fn()
      .mockResolvedValueOnce(result({ totalCleaned: 42, filesDeleted: 3 }))
      .mockRejectedValueOnce(failure)
    const ids = Array.from({ length: CLEANER_BATCH_SIZE + 1 }, (_, index) => String(index))

    const cleaned = await cleanInBatches(ids, clean)

    expect(cleaned.result).toEqual(result({ totalCleaned: 42, filesDeleted: 3 }))
    expect(cleaned.error).toBe(failure)
  })
})
