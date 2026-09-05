import { lstat, readdir } from 'fs/promises'
import { join } from 'path'
import { CooperativeScheduler } from './cooperative-scheduler'

/** Logical file bytes, not allocated/free-volume bytes (compression and links differ). */
export interface MeasuredEntry { path: string; size: number }

export async function measureCleanupTree(root: string): Promise<MeasuredEntry[]> {
  const entries: MeasuredEntry[] = []
  const queue = [root]
  const scheduler = new CooperativeScheduler()
  while (queue.length) {
    const path = queue.pop()!
    try {
      const info = await lstat(path)
      entries.push({ path, size: info.isFile() ? info.size : 0 })
      if (info.isDirectory() && !info.isSymbolicLink()) {
        for (const child of await readdir(path)) queue.push(join(path, child))
      }
    } catch { /* Unreadable entries never contribute estimated reclaimed bytes. */ }
    await scheduler.yieldIfNeeded()
  }
  return entries
}

/** A failed recursive removal can still have removed most of its children. */
export async function removedCleanupEntries(before: MeasuredEntry[]): Promise<MeasuredEntry[]> {
  const removed: MeasuredEntry[] = []
  const scheduler = new CooperativeScheduler()
  for (const entry of before) {
    try { await lstat(entry.path) } catch (err: any) {
      if (err.code === 'ENOENT') removed.push(entry)
    }
    await scheduler.yieldIfNeeded()
  }
  return removed
}
