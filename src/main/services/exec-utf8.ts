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

/**
 * Escape a single argument for safe inclusion in a cmd.exe command string.
 *
 * cmd.exe metacharacters (&, |, <, >, ^, !, %, (, )) are interpreted
 * when arguments are concatenated into a single string.  Wrapping an
 * argument in double-quotes neutralises all of them except `%` and `!`
 * (which are handled by /V:OFF — the default — and by not using
 * delayed expansion).  Embedded double-quotes are escaped as `""`.
 *
 * We quote any argument that contains whitespace, metacharacters, or
 * double-quotes.  Arguments that are already safe are returned as-is.
 */
function cmdEscapeArg(arg: string): string {
  if (arg.length === 0) return '""'
  if (!/[\s"&|<>^!%()]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

/**
 * Execute a native Windows CLI tool (reg.exe, pnputil, etc.) with the
 * console code page set to 65001 (UTF-8) so that non-ASCII characters
 * in the output are correctly decoded by Node.js.
 *
 * Builds the full command string manually and uses
 * `windowsVerbatimArguments: true` so that Node.js does not re-quote.
 * Each argument is escaped for cmd.exe metacharacters to prevent
 * injection from dynamic values (registry names, task paths, etc.).
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
  // Build the full command: chcp to switch to UTF-8, then tool + escaped args.
  const escaped = args.map(cmdEscapeArg)
  const cmdLine = `chcp 65001 >nul && ${tool} ${escaped.join(' ')}`

  // Execute via cmd.exe directly, passing the complete command string as
  // a single argument.  windowsVerbatimArguments prevents Node.js from
  // adding its own quoting layer on top of ours.
  return execFileAsync('cmd.exe', ['/d', '/s', '/c', cmdLine], {
    encoding: 'utf-8',
    windowsHide: opts?.windowsHide ?? true,
    windowsVerbatimArguments: true,
    timeout: opts?.timeout ?? 15_000,
    ...(opts?.maxBuffer != null && { maxBuffer: opts.maxBuffer }),
  })
}
