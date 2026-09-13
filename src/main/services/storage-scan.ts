import { lstat, opendir, realpath } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { isExcluded } from './file-utils'
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
        canonical(await realpath(dir.path)) !== canonical(dir.path)
      ) {
        skipped++
        partial = true
        continue
      }
      const handle = await opendir(dir.path)
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
          const stat = await lstat(path)
          if (stat.isSymbolicLink() || stat.dev !== initial.dev) {
            skipped++
            continue
          }
          if (stat.isDirectory()) {
            if (dir.depth >= 128 || queue.length + directories >= limits.directories) {
              partial = true
              reason = 'limit'
              continue
            }
            if (dir.depth < 3) {
              const key = relative(root, path).split(sep).join('/')
              if (rows.size >= limits.rows) {
                partial = true
                reason = 'limit'
                continue
              }
              rows.set(key, { path: key, bytes: 0, files: 0 })
            }
            queue.push({ path, depth: dir.depth + 1 })
          } else if (stat.isFile()) {
            if (canonical(await realpath(path)) !== canonical(path)) {
              skipped++
              partial = true
              continue
            }
            const parts = relative(root, dir.path).split(sep).filter(Boolean)
            for (let depth = 0; depth <= Math.min(3, parts.length); depth++) {
              const row = rows.get(parts.slice(0, depth).join('/'))
              if (row) {
                row.bytes += stat.size
                row.files++
              }
            }
          } else skipped++
        } catch {
          errors++
          partial = true
        }
        if (visited % 100 === 0) await new Promise<void>((r) => setImmediate(r))
      }
      const after = await lstat(dir.path)
      if (after.ino !== info.ino || after.dev !== info.dev || after.isSymbolicLink()) {
        partial = true
        reason = 'changed'
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
