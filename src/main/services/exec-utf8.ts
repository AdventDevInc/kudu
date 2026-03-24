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

import { execFile, type ExecFileOptions } from 'child_process'
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
 * @param tool  The executable name (e.g. 'reg', 'pnputil')
 * @param args  Arguments that would normally be passed to execFileAsync
 * @param opts  Standard ExecFileOptions (timeout, windowsHide, etc.)
 */
export async function execNativeUtf8(
  tool: string,
  args: string[],
  opts?: Pick<ExecFileOptions, 'timeout' | 'windowsHide' | 'maxBuffer'>
): Promise<{ stdout: string; stderr: string }> {
  if (!ALLOWED_TOOLS.has(tool.toLowerCase())) {
    throw new Error(`execNativeUtf8: disallowed tool "${tool}"`)
  }

  const baseOpts = {
    encoding: 'utf-8' as const,
    windowsHide: opts?.windowsHide ?? true,
    timeout: opts?.timeout ?? 15_000,
    ...(opts?.maxBuffer != null && { maxBuffer: opts.maxBuffer }),
  }

  // If any argument contains %, call the tool directly to avoid cmd.exe's
  // %VAR% expansion which would corrupt literal percent sequences like
  // %APPDATA%\App\app.exe stored in registry values.
  if (args.some(a => a.includes('%'))) {
    return execFileAsync(tool, args, baseOpts)
  }

  // Pass arguments via environment variables so no user-controlled data
  // appears in the command string.  cmd.exe expands the hardcoded
  // %__KAn% references from the child-process environment at runtime.
  // Embedded double-quotes are escaped as "" to keep cmd.exe quoting intact.
  const env: Record<string, string> = { ...process.env }
  const refs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const key = `__KA${i}`
    env[key] = args[i].replace(/"/g, '""')
    refs.push(`"%${key}%"`)
  }

  const cmdLine = `chcp 65001 >nul && ${tool} ${refs.join(' ')}`

  // /v:off disables delayed expansion so ! in env var values is not re-expanded
  return execFileAsync('cmd.exe', ['/d', '/v:off', '/s', '/c', cmdLine], {
    ...baseOpts,
    env,
    windowsVerbatimArguments: true,
  })
}
