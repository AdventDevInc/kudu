/**
 * Utilities for executing Windows commands with correct UTF-8 encoding.
 *
 * Problem: PowerShell defaults to UTF-16-LE output, and native tools
 * (reg.exe, pnputil, sfc, dism) use the system's OEM code page (e.g. CP1252).
 * Node.js decodes stdout as UTF-8, corrupting accented characters.
 *
 * Solution:
 *  - PowerShell: prefix commands with [Console]::OutputEncoding = UTF-8
 *  - Native tools: run via cmd /c with chcp 65001 (UTF-8 code page)
 */

import { execFile, type ExecFileOptions, type ChildProcess } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** Prefix that forces PowerShell to emit UTF-8 on stdout */
const PS_UTF8_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; '

/**
 * Prepend the UTF-8 preamble to a PowerShell command string.
 * Use this when building the `-Command` argument for `powershell.exe`.
 */
export function psUtf8(command: string): string {
  return PS_UTF8_PREAMBLE + command
}

/** Tools that may be invoked through cmd.exe via execNativeUtf8 */
const ALLOWED_TOOLS = new Set([
  'reg', 'reg.exe',
  'netsh', 'netsh.exe',
  'pnputil', 'pnputil.exe',
  'schtasks', 'schtasks.exe',
  'ipconfig', 'ipconfig.exe',
])

// ── Active child-process tracking ──
// Every process spawned by execNativeUtf8 is tracked here so we can
// kill the entire process tree on abort, timeout, or app exit.
const activeChildren = new Set<ChildProcess>()

/**
 * Kill a child process and its entire process tree on Windows.
 * On non-Windows platforms, falls back to process.kill().
 */
function killTree(child: ChildProcess): void {
  if (!child.pid) return
  activeChildren.delete(child)
  try {
    if (process.platform === 'win32') {
      // taskkill /T kills the process tree; /F forces termination
      execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {})
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // Process may have already exited
  }
}

/**
 * Kill all tracked child processes and their trees.
 * Called on app exit to prevent orphaned reg.exe / cmd.exe processes.
 */
export function killAllChildren(): void {
  for (const child of activeChildren) {
    killTree(child)
  }
  activeChildren.clear()
}

/**
 * Wrap a spawned child process with timeout and abort-signal handling
 * that kills the entire process tree (not just the root) on Windows.
 *
 * @returns A cleanup function to call after the promise settles.
 */
function trackChild(
  child: ChildProcess | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onKill: () => void
): () => void {
  // In test environments the mock may not return a real ChildProcess.
  if (!child || typeof child.on !== 'function') return () => {}

  activeChildren.add(child)

  const timer = setTimeout(() => {
    killTree(child)
    onKill()
  }, timeoutMs)

  const clearTimer = () => clearTimeout(timer)
  child.on('exit', clearTimer)

  let abortHandler: (() => void) | undefined
  if (signal) {
    abortHandler = () => {
      clearTimeout(timer)
      killTree(child)
      onKill()
    }
    if (signal.aborted) {
      abortHandler()
    } else {
      signal.addEventListener('abort', abortHandler, { once: true })
    }
  }

  // Return cleanup for after the promise settles
  return () => {
    clearTimeout(timer)
    activeChildren.delete(child)
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler)
    }
  }
}

/**
 * Execute a native Windows CLI tool (reg.exe, pnputil, etc.) with the
 * console code page set to 65001 (UTF-8) so that non-ASCII characters
 * in the output are correctly decoded by Node.js.
 *
 * Arguments are passed via temporary environment variables (`__KA0`,
 * `__KA1`, …) so that no user-controlled data is concatenated into the
 * command string.  The command line contains only hardcoded `%__KAn%`
 * references which cmd.exe expands from the child-process environment
 * at runtime.  This prevents command-injection via dynamic values such
 * as registry paths, task names, or Wi-Fi profile names.
 *
 * **%VAR% expansion caveat**: cmd.exe expands `%ENVVAR%` patterns even
 * inside double-quotes, and there is no reliable escape in command-line
 * mode.  If any argument contains a literal `%`, we fall back to a
 * direct `execFile` call (no shell) which bypasses cmd.exe entirely.
 * This skips the `chcp 65001` code-page switch, but `%` in arguments
 * occurs almost exclusively in write operations (e.g. `reg add /d`)
 * whose output is plain ASCII, so the trade-off is safe.
 *
 * **Process tree killing**: On timeout or abort, the entire process
 * tree (cmd.exe + reg.exe) is killed via `taskkill /T /F /PID` to
 * prevent orphaned child processes.
 *
 * @param tool  The executable name (e.g. 'reg', 'pnputil')
 * @param args  Arguments that would normally be passed to execFileAsync
 * @param opts  Standard ExecFileOptions (timeout, windowsHide, etc.)
 */
export async function execNativeUtf8(
  tool: string,
  args: string[],
  opts?: Pick<ExecFileOptions, 'timeout' | 'windowsHide' | 'maxBuffer'> & { signal?: AbortSignal }
): Promise<{ stdout: string; stderr: string }> {
  if (!ALLOWED_TOOLS.has(tool.toLowerCase())) {
    throw new Error(`execNativeUtf8: disallowed tool "${tool}"`)
  }

  // Bail immediately if already aborted
  if (opts?.signal?.aborted) {
    throw new Error('Operation cancelled')
  }

  const timeoutMs = opts?.timeout ?? 15_000

  const baseOpts = {
    encoding: 'utf-8' as const,
    windowsHide: opts?.windowsHide ?? true,
    timeout: timeoutMs,
    ...(opts?.maxBuffer != null && { maxBuffer: opts.maxBuffer }),
  }

  // If any argument contains %, call the tool directly to avoid cmd.exe's
  // %VAR% expansion which would corrupt literal percent sequences like
  // %APPDATA%\App\app.exe stored in registry values.
  if (args.some(a => a.includes('%'))) {
    const promise = execFileAsync(tool, args, baseOpts) as
      Promise<{ stdout: string; stderr: string }> & { child?: ChildProcess }
    let killed = false
    const cleanup = trackChild(promise.child, timeoutMs, opts?.signal, () => { killed = true })
    try {
      return await promise
    } catch (err: any) {
      if (killed || opts?.signal?.aborted) throw new Error('Operation cancelled')
      throw err
    } finally {
      cleanup()
    }
  }

  // Pass arguments via environment variables so no user-controlled data
  // appears in the command string.  cmd.exe expands the hardcoded
  // %__KAn% references from the child-process environment at runtime.
  // Embedded double-quotes are escaped as "" to keep cmd.exe quoting intact.
  const env = { ...process.env } as Record<string, string>
  const refs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const key = `__KA${i}`
    env[key] = args[i].replace(/"/g, '""')
    refs.push(`"%${key}%"`)
  }

  const cmdLine = `chcp 65001 >nul && ${tool} ${refs.join(' ')}`

  // /v:off disables delayed expansion so ! in env var values is not re-expanded
  const promise = execFileAsync('cmd.exe', ['/d', '/v:off', '/s', '/c', cmdLine], {
    ...baseOpts,
    env,
    windowsVerbatimArguments: true,
  }) as Promise<{ stdout: string; stderr: string }> & { child?: ChildProcess }

  let killed = false
  const cleanup = trackChild(promise.child, timeoutMs, opts?.signal, () => { killed = true })
  try {
    return await promise
  } catch (err: any) {
    if (killed || opts?.signal?.aborted) throw new Error('Operation cancelled')
    // Replace %__KAn% placeholders in the error message with actual
    // argument values so the user sees meaningful commands, not internal
    // variable references.
    if (err.message) {
      err.message = err.message.replace(/"%__KA(\d+)%"/g, (_m: string, idx: string) => {
        const i = parseInt(idx, 10)
        return i < args.length ? JSON.stringify(args[i]) : _m
      })
    }
    throw err
  } finally {
    cleanup()
  }
}
