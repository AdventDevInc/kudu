import { lstat, readdir } from 'fs/promises'
import { join } from 'path'
import { CooperativeScheduler } from './cooperative-scheduler'

/** Logical file bytes, not allocated/free-volume bytes (compression and links differ). */
export interface MeasuredEntry { path: string; size: number }

async function* walkCleanupTree(root: string, maxDepth = Infinity): AsyncGenerator<MeasuredEntry> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  const scheduler = new CooperativeScheduler()
  while (queue.length) {
    const { path, depth } = queue.pop()!
    try {
      const info = await lstat(path)
      yield { path, size: info.isFile() ? info.size : 0 }
      if (info.isDirectory() && !info.isSymbolicLink() && depth < maxDepth) {
        for (const child of await readdir(path)) queue.push({ path: join(path, child), depth: depth + 1 })
      }
    } catch { /* Unreadable entries never contribute estimated reclaimed bytes. */ }
    await scheduler.yieldIfNeeded()
  }
}

/** A snapshot is needed only when cleanup must reconcile individual removals. */
export async function measureCleanupTree(root: string): Promise<MeasuredEntry[]> {
  const entries: MeasuredEntry[] = []
  for await (const entry of walkCleanupTree(root)) entries.push(entry)
  return entries
}

/** Sum without retaining a full path snapshot; callers may bound estimates. */
export async function cleanupTreeSize(root: string, maxDepth = Infinity): Promise<number> {
  if (Number.isNaN(maxDepth) || maxDepth <= 0) return 0
  let size = 0
  for await (const entry of walkCleanupTree(root, maxDepth)) size += entry.size
  return size
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
