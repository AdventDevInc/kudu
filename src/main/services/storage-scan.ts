import { lstat, opendir, realpath, stat } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { isExcluded } from './file-utils'
import { mountPoints } from './mount-points'
import type { StorageRow } from '../../shared/storage-history'

/** Check every ancestor; lstat on only the final path would follow parent junctions. */
export async function validateStorageRoot(path: string): Promise<string> {
  if (!isAbsolute(path) || path.startsWith('\\\\') || path.includes('\0'))
    throw new Error('Choose a local folder')
  const root = resolve(path)
  for (let current = root; ; current = dirname(current)) {
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('Linked folders are not supported')
    if (dirname(current) === current) break
  }
  return root
}

const canonical = (path: string) =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

export async function measureStorageScope(
  root: string,
  exclusions: string[],
  signal: AbortSignal,
  limits = { entries: 250000, directories: 30000, rows: 5000, milliseconds: 300000 }
) {
  const started = Date.now()
  const initial = await lstat(await validateStorageRoot(root))
  // Compare against the canonical root so 8.3 short names and macOS /private aliases of the
  // root itself are not mistaken for links, while links introduced below the root still are.
  const realRoot = await realpath(root)
  // Linux bind mounts keep the source st_dev and survive realpath(), so mount points below
  // the root are detected explicitly. The root itself may be a mount point and is still scanned.
  const mounts = await mountPoints()
  const aliased = async (path: string) =>
    canonical(await realpath(path)) !== canonical(join(realRoot, relative(root, path)))
  const rows = new Map<string, StorageRow>([['', { path: '', bytes: 0, files: 0 }]])
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  let visited = 0,
    directories = 0,
    skipped = 0,
    errors = 0,
    partial = false,
    reason: string | null = null
  if (isExcluded(root, exclusions))
    return {
      rows: [],
      totalBytes: 0,
      files: 0,
      skipped: 1,
      errors: 0,
      status: 'unavailable' as const,
      reason: 'excluded'
    }
  outer: while (queue.length) {
    if (signal.aborted) {
      reason = 'cancelled'
      break
    }
    if (
      visited >= limits.entries ||
      directories >= limits.directories ||
      Date.now() - started >= limits.milliseconds
    ) {
      partial = true
      reason = 'limit'
      break
    }
    const dir = queue.pop()!
    directories++
    try {
      // Revalidate before opening a queued directory; never intentionally traverse an alias.
      const info = await lstat(dir.path)
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        info.dev !== initial.dev ||
        (dir.depth > 0 && mounts.has(resolve(dir.path))) ||
        (await aliased(dir.path))
      ) {
        skipped++
        partial = true
        continue
      }
      const handle = await opendir(dir.path)
      // opendir follows a symlink swapped in after the lstat above; confirm the opened directory
      // is still the validated one before reading anything from it.
      const [opened, link] = await Promise.all([stat(dir.path), lstat(dir.path)])
      if (opened.ino !== info.ino || opened.dev !== info.dev || link.isSymbolicLink()) {
        await handle.close()
        skipped++
        partial = true
        reason = 'changed'
        continue
      }
      // Everything this directory contributes is staged locally and only committed once the
      // post-iteration check confirms it was not replaced mid-read; a swap contributes nothing.
      let bytes = 0,
        files = 0
      const children: Array<{ path: string; depth: number }> = []
      const keys: string[] = []
      for await (const item of handle) {
        if (signal.aborted) {
          reason = 'cancelled'
          break outer
        }
        if (++visited > limits.entries || Date.now() - started >= limits.milliseconds) {
          partial = true
          reason = 'limit'
          break outer
        }
        const path = join(dir.path, item.name)
        if (isExcluded(path, exclusions)) {
          skipped++
          continue
        }
        try {
          const entry = await lstat(path)
          // Mount points are checked before branching on type: a Linux bind mount can expose a
          // regular file (not only a directory) that still reports the root's device ID.
          if (entry.isSymbolicLink() || entry.dev !== initial.dev || mounts.has(resolve(path))) {
            skipped++
            continue
          }
          if (entry.isDirectory()) {
            if (
              dir.depth >= 128 ||
              queue.length + children.length + directories >= limits.directories
            ) {
              partial = true
              reason = 'limit'
              continue
            }
            // Past the row limit only the per-folder detail row is dropped; the subtree is still
            // traversed so its bytes reach every existing ancestor row, including the root total.
            if (dir.depth < 3 && rows.size + keys.length < limits.rows)
              keys.push(relative(root, path).split(sep).join('/'))
            children.push({ path, depth: dir.depth + 1 })
          } else if (entry.isFile()) {
            // The containing directory was already revalidated (lstat, device and alias checks)
            // before opening, and lstat above rejects file links, so no per-file realpath is needed.
            bytes += entry.size
            files++
          } else skipped++
        } catch {
          errors++
          partial = true
        }
        if (visited % 100 === 0) await new Promise<void>((r) => setImmediate(r))
      }
      const after = await lstat(dir.path)
      if (after.ino !== info.ino || after.dev !== info.dev || after.isSymbolicLink()) {
        skipped++
        partial = true
        reason = 'changed'
        continue
      }
      for (const key of keys) rows.set(key, { path: key, bytes: 0, files: 0 })
      queue.push(...children)
      const parts = relative(root, dir.path).split(sep).filter(Boolean)
      for (let depth = 0; depth <= Math.min(3, parts.length); depth++) {
        const row = rows.get(parts.slice(0, depth).join('/'))
        if (row) {
          row.bytes += bytes
          row.files += files
        }
      }
    } catch {
      errors++
      partial = true
    }
  }
  try {
    const final = await lstat(root)
    if (final.ino !== initial.ino || final.dev !== initial.dev || final.isSymbolicLink()) {
      partial = true
      reason = 'changed'
    }
  } catch {
    partial = true
    reason = 'unavailable'
  }
  return {
    rows: [...rows.values()],
    totalBytes: rows.get('')!.bytes,
    files: rows.get('')!.files,
    skipped,
    errors,
    status: signal.aborted
      ? ('cancelled' as const)
      : partial
        ? ('partial' as const)
        : ('complete' as const),
    reason: reason ?? (errors ? 'inaccessible' : null)
  }
}
