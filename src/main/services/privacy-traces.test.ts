import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./settings-store', () => ({
  getSettings: () => ({ cleaner: { secureDelete: false }, exclusions: [] })
}))
vi.mock('./deletion-log-store', () => ({ recordDeletions: () => {} }))

import { getCachedItem } from './scan-cache'
import {
  CHANGED_SINCE_SCAN,
  cleanPrivacyTraces,
  scanPrivacyTraces,
  openVerifiedTrace,
  overwriteThroughHandle,
  statTraceFile,
  truncateTraceFile,
  type PrivacyTrace,
  type TraceScanContext
} from './privacy-traces'
import { findShellHistoryTraces, histfileInsideHome } from './privacy-traces-shell'

let home: string
const tracePaths = (groups: Awaited<ReturnType<typeof findShellHistoryTraces>>) =>
  groups.flatMap((g) => g.traces.map((t) => t.path)).sort()

function ctx(overrides: Partial<TraceScanContext> = {}): TraceScanContext {
  return { platform: 'linux', home, env: {}, exclusions: [], ...overrides }
}

async function put(path: string, content = 'ls -la\n'): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  return path
}

/**
 * Replace a file with a new one. The old file stays alive until the new one
 * exists, otherwise the filesystem may hand the new file the same inode.
 */
async function replaceFile(path: string, content: string): Promise<void> {
  await rename(path, path + '.old')
  await put(path, content)
  await rm(path + '.old')
}

/** Symlinks need Developer Mode or elevation on Windows; skip rather than fail there. */
async function trySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, 'file')
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'kudu-traces-')))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('shell history discovery', () => {
  it('finds Unix shell and REPL histories that exist and are non-empty', async () => {
    const expected = [
      await put(join(home, '.bash_history')),
      await put(join(home, '.zsh_history')),
      await put(join(home, '.zsh_sessions', 'ABC-123.history')),
      await put(join(home, '.local', 'share', 'fish', 'fish_history')),
      await put(
        join(home, '.local', 'share', 'powershell', 'PSReadLine', 'ConsoleHost_history.txt')
      ),
      await put(join(home, '.python_history')),
      await put(join(home, '.node_repl_history')),
      await put(join(home, '.lesshst')),
      await put(join(home, '.sqlite_history')),
      await put(join(home, '.mysql_history')),
      await put(join(home, '.psql_history')),
      await put(join(home, '.rediscli_history')),
      await put(join(home, '.irb_history'))
    ]
    await put(join(home, '.zsh_sessions', 'ABC-123.session'))
    await put(join(home, '.viminfo'))
    await put(join(home, '.mysql_history_empty'), '')
    await writeFile(join(home, '.psql_history'), '') // exists but empty

    const groups = await findShellHistoryTraces(ctx())
    expect(groups).toHaveLength(1)
    expect(groups[0].subcategory).toBe('Shell history')
    expect(groups[0].descriptionKey).toBe('privacyShellHistoryNote')
    expect(tracePaths(groups)).toEqual(expected.filter((p) => !p.endsWith('.psql_history')).sort())
  })

  it('finds PSReadLine, Git Bash and REPL histories on Windows', async () => {
    const appData = join(home, 'AppData', 'Roaming')
    const psDir = join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine')
    const expected = [
      await put(join(psDir, 'ConsoleHost_history.txt')),
      await put(join(psDir, 'Visual Studio Code Host_history.txt')),
      await put(join(home, '.bash_history')),
      await put(join(home, '.python_history')),
      await put(join(home, '.node_repl_history'))
    ]
    await put(join(psDir, 'notes.txt'))
    // Unix-only names are not looked for on Windows.
    await put(join(home, '.zsh_history'))

    const groups = await findShellHistoryTraces(
      ctx({ platform: 'win32', env: { APPDATA: appData } })
    )
    expect(tracePaths(groups)).toEqual(expected.sort())
  })

  it('returns no group when nothing is found', async () => {
    expect(await findShellHistoryTraces(ctx())).toEqual([])
  })

  it('never lists symlinked history files', async () => {
    const real = await put(join(home, 'dotfiles', 'bash_history'))
    if (!(await trySymlink(real, join(home, '.bash_history')))) return
    expect(await findShellHistoryTraces(ctx())).toEqual([])
  })

  it('never lists hard-linked history files', async () => {
    const real = await put(join(home, 'elsewhere'))
    await link(real, join(home, '.bash_history'))
    expect(await findShellHistoryTraces(ctx())).toEqual([])
  })

  it('respects $HISTFILE inside home and de-duplicates it', async () => {
    const custom = await put(join(home, '.config', 'bash', 'history'))
    const bash = await put(join(home, '.bash_history'))
    const withCustom = await findShellHistoryTraces(ctx({ env: { HISTFILE: custom } }))
    expect(tracePaths(withCustom)).toEqual([bash, custom].sort())
    const duplicate = await findShellHistoryTraces(ctx({ env: { HISTFILE: bash } }))
    expect(tracePaths(duplicate)).toEqual([bash])
  })

  it('ignores $HISTFILE outside home or not absolute', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kudu-outside-'))
    try {
      expect(await histfileInsideHome(join(outside, '.bash_history'), home)).toBeNull()
      expect(await histfileInsideHome(home, home)).toBeNull()
      expect(await histfileInsideHome('.bash_history', home)).toBeNull()
      expect(await histfileInsideHome(undefined, home)).toBeNull()
      expect(await histfileInsideHome(join(home, 'h'), home)).toBe(join(await realpath(home), 'h'))
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('ignores $HISTFILE reaching outside home through a symlinked directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kudu-outside-'))
    try {
      const victim = await put(join(outside, 'victim'), 'keep me\n')
      if (!(await trySymlink(outside, join(home, 'link')))) return
      expect(await histfileInsideHome(join(home, 'link', 'victim'), home)).toBeNull()
      const groups = await findShellHistoryTraces(
        ctx({ env: { HISTFILE: join(home, 'link', 'victim') } })
      )
      expect(tracePaths(groups)).not.toContain(join(home, 'link', 'victim'))
      expect(await readFile(victim, 'utf8')).toBe('keep me\n')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('shell history locations', () => {
  it('uses $XDG_DATA_HOME for fish and PowerShell, and Application Support on macOS', async () => {
    const data = join(home, 'data')
    const fish = await put(join(data, 'fish', 'fish_history'))
    const ps = await put(join(data, 'powershell', 'PSReadLine', 'ConsoleHost_history.txt'))
    const macPs = await put(
      join(
        home,
        'Library',
        'Application Support',
        'powershell',
        'PSReadLine',
        'ConsoleHost_history.txt'
      )
    )
    const linux = await findShellHistoryTraces(ctx({ env: { XDG_DATA_HOME: data } }))
    expect(tracePaths(linux)).toEqual([fish, ps].sort())
    const mac = await findShellHistoryTraces(
      ctx({ platform: 'darwin', env: { XDG_DATA_HOME: data } })
    )
    expect(tracePaths(mac)).toEqual([fish, macPs, ps].sort())
  })
})

describe('scanPrivacyTraces', () => {
  it('returns every item unselected and keeps it out of the shared scan cache', async () => {
    await put(join(home, '.bash_history'))
    const cache = new Map<string, PrivacyTrace>()
    const results = await scanPrivacyTraces([findShellHistoryTraces], ctx(), cache)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      category: 'privacyTraces',
      subcategory: 'Shell history',
      descriptionKey: 'privacyShellHistoryNote',
      itemCount: 1,
      totalSize: 7
    })
    const [item] = results[0].items
    expect(item.selected).toBe(false)
    expect(cache.has(item.id)).toBe(true)
    expect(getCachedItem(item.id)).toBeUndefined()
  })

  it('drops traces matched by the global exclusions', async () => {
    const bash = await put(join(home, '.bash_history'))
    await put(join(home, '.zsh_history'))
    const cache = new Map<string, PrivacyTrace>()
    const results = await scanPrivacyTraces(
      [findShellHistoryTraces],
      ctx({ exclusions: [join(home, '.zsh_history')] }),
      cache
    )
    expect(results.flatMap((r) => r.items.map((i) => i.path))).toEqual([bash])
  })

  it('keeps other providers when one fails', async () => {
    await put(join(home, '.bash_history'))
    const results = await scanPrivacyTraces(
      [
        async () => {
          throw new Error('boom')
        },
        findShellHistoryTraces
      ],
      ctx(),
      new Map()
    )
    expect(results).toHaveLength(1)
  })
})

describe('truncation', () => {
  it('empties the file in place, preserving the file and its mode', async () => {
    const path = await put(join(home, '.bash_history'), 'secret command\n')
    if (process.platform !== 'win32') await chmod(path, 0o600)
    const before = await stat(path)
    const info = (await statTraceFile(path))!
    expect(await truncateTraceFile(path, info, { secureDelete: false })).toBe(15)
    const after = await stat(path)
    expect(after.size).toBe(0)
    expect(after.ino).toBe(before.ino)
    expect(after.mode).toBe(before.mode)
  })

  it('overwrites through the verified handle before truncating when secure delete is on', async () => {
    const path = await put(join(home, '.bash_history'), 'secret command\n')
    const before = await stat(path)
    const info = (await statTraceFile(path))!
    expect(await truncateTraceFile(path, info, { secureDelete: true })).toBe(15)
    expect(await readFile(path, 'utf8')).toBe('')
    expect((await stat(path)).ino).toBe(before.ino)
  })

  it('overwrites every byte with the random pass then zeros', async () => {
    const path = await put(join(home, 'blob'), 'x'.repeat(3000))
    const handle = await openVerifiedTrace(path, (await statTraceFile(path))!)
    try {
      await overwriteThroughHandle(handle, 3000)
    } finally {
      await handle.close()
    }
    const data = await readFile(path)
    expect(data.length).toBe(3000)
    expect(data.every((b) => b === 0)).toBe(true)
  })

  it('never writes to a file swapped in after the scan, even with secure delete on', async () => {
    const path = await put(join(home, '.bash_history'), 'old\n')
    const info = (await statTraceFile(path))!
    await replaceFile(path, 'replacement history\n')
    await expect(truncateTraceFile(path, info, { secureDelete: true })).rejects.toMatchObject({
      reason: CHANGED_SINCE_SCAN
    })
    expect(await readFile(path, 'utf8')).toBe('replacement history\n')
  })

  it('refuses a file replaced since the scan', async () => {
    const path = await put(join(home, '.bash_history'), 'old\n')
    const info = (await statTraceFile(path))!
    await replaceFile(path, 'new history\n')
    await expect(truncateTraceFile(path, info, { secureDelete: false })).rejects.toMatchObject({
      reason: CHANGED_SINCE_SCAN
    })
    expect(await readFile(path, 'utf8')).toBe('new history\n')
  })

  it('refuses a file swapped for a symlink since the scan', async () => {
    const path = await put(join(home, '.bash_history'), 'history\n')
    const victim = await put(join(home, 'important.txt'), 'keep me\n')
    const info = (await statTraceFile(path))!
    await rm(path)
    if (!(await trySymlink(victim, path))) return
    await expect(truncateTraceFile(path, info, { secureDelete: true })).rejects.toBeDefined()
    expect(await readFile(victim, 'utf8')).toBe('keep me\n')
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
  })
})

describe('cleanPrivacyTraces', () => {
  it('clears selected traces and reports cleared bytes', async () => {
    const path = await put(join(home, '.bash_history'), 'abc\n')
    const cache = new Map<string, PrivacyTrace>()
    const [result] = await scanPrivacyTraces([findShellHistoryTraces], ctx(), cache)
    const outcome = await cleanPrivacyTraces([result.items[0].id], cache, {
      secureDelete: false,
      exclusions: []
    })
    expect(outcome).toMatchObject({ totalCleaned: 4, filesDeleted: 1, filesSkipped: 0 })
    expect((await stat(path)).size).toBe(0)
    expect(cache.size).toBe(0)
  })

  it('re-checks exclusions at clean time', async () => {
    const path = await put(join(home, '.bash_history'), 'abc\n')
    const cache = new Map<string, PrivacyTrace>()
    const [result] = await scanPrivacyTraces([findShellHistoryTraces], ctx(), cache)
    const outcome = await cleanPrivacyTraces([result.items[0].id], cache, {
      secureDelete: false,
      exclusions: [home]
    })
    expect(outcome.filesSkipped).toBe(1)
    expect(outcome.errors).toEqual([{ path, reason: 'excluded' }])
    expect(await readFile(path, 'utf8')).toBe('abc\n')
  })

  it('skips unknown IDs and continues past failures', async () => {
    const path = await put(join(home, '.bash_history'), 'abc\n')
    const cache = new Map<string, PrivacyTrace>()
    const [result] = await scanPrivacyTraces([findShellHistoryTraces], ctx(), cache)
    await rm(path)
    const outcome = await cleanPrivacyTraces(['unknown', result.items[0].id], cache, {
      secureDelete: false,
      exclusions: []
    })
    expect(outcome.filesDeleted).toBe(0)
    expect(outcome.errors).toEqual([
      { path: 'unknown', reason: 'scan-result-expired' },
      { path, reason: 'not-found' }
    ])
  })
})

describe('overwriteThroughHandle short writes', () => {
  it('keeps writing until each chunk is complete', async () => {
    const writes: Array<{ offset: number; length: number; position: number }> = []
    const handle = {
      write: vi.fn(async (_buf: Buffer, offset: number, length: number, position: number) => {
        writes.push({ offset, length, position })
        // Only ever accept half of what was asked for (at least one byte).
        return { bytesWritten: Math.max(1, Math.floor(length / 2)) }
      }),
      datasync: vi.fn(async () => {})
    }
    await overwriteThroughHandle(handle as never, 10)
    const covered = (pass: number) =>
      writes
        .slice(pass * (writes.length / 2), (pass + 1) * (writes.length / 2))
        .reduce((sum, w) => sum + Math.max(1, Math.floor(w.length / 2)), 0)
    expect(covered(0)).toBe(10)
    expect(covered(1)).toBe(10)
    expect(writes[1]).toMatchObject({ offset: 5, position: 5 })
    expect(handle.datasync).toHaveBeenCalledTimes(2)
  })
})
