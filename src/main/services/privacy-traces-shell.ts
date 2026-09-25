import { readdir } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import {
  statTraceFile,
  truncatingTrace,
  type PrivacyTrace,
  type PrivacyTraceGroup,
  type TraceScanContext
} from './privacy-traces'

/** Top-level history files in the home directory, per platform. */
const WINDOWS_HOME_HISTORY = ['.bash_history', '.python_history', '.node_repl_history']
const UNIX_HOME_HISTORY = [
  '.bash_history',
  '.zsh_history',
  '.python_history',
  '.node_repl_history',
  '.lesshst',
  '.sqlite_history',
  '.mysql_history',
  '.psql_history',
  '.rediscli_history',
  '.irb_history'
]
// Deliberately absent: .viminfo and similar files which mix history with
// editor state (registers, marks, buffer lists) the user would lose.

const PSREADLINE_HISTORY = /_history\.txt$/i
const ZSH_SESSION_HISTORY = /\.history$/

/** A directory glob: every direct child of `dir` whose name matches `pattern`. */
interface HistoryDir {
  dir: string
  pattern: RegExp
}

function historyCandidates(ctx: TraceScanContext): { files: string[]; dirs: HistoryDir[] } {
  const { home } = ctx
  if (ctx.platform === 'win32') {
    const appData = ctx.env.APPDATA || join(home, 'AppData', 'Roaming')
    return {
      files: WINDOWS_HOME_HISTORY.map((name) => join(home, name)),
      dirs: [
        {
          // Windows PowerShell and PowerShell 7 share this PSReadLine directory.
          dir: join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine'),
          pattern: PSREADLINE_HISTORY
        }
      ]
    }
  }
  return {
    files: [
      ...UNIX_HOME_HISTORY.map((name) => join(home, name)),
      join(home, '.local', 'share', 'fish', 'fish_history')
    ],
    dirs: [
      // macOS Terminal keeps one history file per restored session.
      { dir: join(home, '.zsh_sessions'), pattern: ZSH_SESSION_HISTORY },
      {
        dir: join(home, '.local', 'share', 'powershell', 'PSReadLine'),
        pattern: PSREADLINE_HISTORY
      }
    ]
  }
}

/** $HISTFILE counts only when it names a path strictly inside the home directory. */
export function histfileInsideHome(histfile: string | undefined, home: string): string | null {
  if (!histfile || !isAbsolute(histfile)) return null
  const target = resolve(histfile)
  const rel = relative(resolve(home), target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return target
}

async function listMatching({ dir, pattern }: HistoryDir): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    // Dirent types come from lstat semantics: symlinks never report isFile().
    return entries.filter((e) => e.isFile() && pattern.test(e.name)).map((e) => join(dir, e.name))
  } catch {
    return []
  }
}

/**
 * Shell and REPL history files which exist and are non-empty. Each is cleared
 * by truncation, so the shell keeps using the same file afterwards.
 */
export async function findShellHistoryTraces(ctx: TraceScanContext): Promise<PrivacyTraceGroup[]> {
  const { files, dirs } = historyCandidates(ctx)
  const histfile = histfileInsideHome(ctx.env.HISTFILE, ctx.home)
  if (histfile) files.push(histfile)
  for (const dir of dirs) files.push(...(await listMatching(dir)))

  const traces: PrivacyTrace[] = []
  const seen = new Set<string>()
  for (const path of files) {
    const info = await statTraceFile(path)
    if (!info || info.size === 0n) continue
    // $HISTFILE usually names one of the well-known files again.
    const identity = `${info.dev}:${info.ino}`
    if (seen.has(identity)) continue
    seen.add(identity)
    traces.push(truncatingTrace(path, info))
  }
  if (traces.length === 0) return []
  return [{ subcategory: 'Shell history', descriptionKey: 'privacyShellHistoryNote', traces }]
}
