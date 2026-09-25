/**
 * Pure text-manipulation utilities for system config files.
 * Shared by Linux and macOS hardening code.
 *
 * These functions operate on strings (file contents) and return strings,
 * making them easy to unit-test without mocking the file system.
 */

// ─── Sysctl config editing ─────────────────────────────────

export const SYSCTL_HEADER = ['# Kudu system hardening — managed automatically']

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Matches a line assigning `param`, with any spaces or tabs around the key and
 * `=` (`key=v`, `key = v`, `\tkey\t=\tv`). Capture, apply, revert and removal
 * all use this one matcher so they agree on which line is the param's.
 */
export function sysctlAssignment(param: string): RegExp {
  return new RegExp(`^[ \t]*${escapeRegExp(param)}[ \t]*=`)
}

/**
 * Update sysctl config file contents by setting `param` to `value`.
 * - Replaces the first existing line for the same param (any spacing, see sysctlAssignment)
 * - Appends if not found, adding a header comment if the file is new
 * - `separator` controls the format: `' = '` for Linux, `'='` for macOS
 * - `headerExtra` is the second comment line (platform-specific revert instructions)
 */
export function updateSysctlConfig(
  existing: string,
  param: string,
  value: string,
  separator: string,
  headerExtra: string
): string {
  const lines = existing.split('\n')
  // Strip trailing blank lines to prevent accumulation
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()

  const newLine = `${param}${separator}${value}`
  const assignment = sysctlAssignment(param)
  let found = false
  for (let i = 0; i < lines.length; i++) {
    if (assignment.test(lines[i])) {
      lines[i] = newLine
      found = true
      break
    }
  }
  if (!found) {
    if (lines.length === 0 || existing.length === 0) {
      lines.length = 0
      lines.push(...SYSCTL_HEADER)
      lines.push(headerExtra)
      lines.push('')
    }
    lines.push(newLine)
  }

  return lines.join('\n') + '\n'
}

/**
 * Remove every line that sets `param` from a sysctl drop-in file.
 * Leaves other params and comments intact.
 */
export function removeSysctlConfigParam(existing: string, param: string): string {
  const assignment = sysctlAssignment(param)
  const lines = existing.split('\n').filter((line) => !assignment.test(line))
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length === 0) return ''
  return lines.join('\n') + '\n'
}

// ─── SSH config editing ─────────────────────────────────────

/**
 * Matches a line (active or commented) for an sshd_config keyword. sshd treats
 * keywords case-insensitively and separates the argument with spaces, tabs or
 * one `=`, so `\tpermitrootlogin=yes` is the same directive as `PermitRootLogin yes`.
 * Matching is per line: blank lines around a directive are never touched.
 */
export function sshdDirective(directive: string): RegExp {
  return new RegExp(`^[ \t]*#?[ \t]*${escapeRegExp(directive)}(?=[ \t=])`, 'i')
}

/**
 * Update sshd_config contents by setting `directive` to `value`.
 * - Comments out ALL existing occurrences of the directive (active or commented)
 * - Preserves lines that already match the exact canonical value (idempotent)
 * - Appends the canonical line if no matching uncommented line exists
 */
export function updateSshdConfig(content: string, directive: string, value: string): string {
  const canonicalLine = `${directive} ${value}`
  const pattern = sshdDirective(directive)

  // Comment out every existing occurrence, except lines that already match
  // the exact canonical value (keeps the file idempotent on repeated applies)
  let updated = content
    .split('\n')
    .map((line) => {
      if (!pattern.test(line)) return line
      const trimmed = line.trimStart()
      if (trimmed === canonicalLine) return line
      return trimmed.startsWith('#') ? line : `# ${trimmed}`
    })
    .join('\n')

  // Only append if no uncommented canonical line exists
  const hasCanonical = updated.split('\n').some((line) => line.trim() === canonicalLine)
  if (!hasCanonical) {
    updated = updated.trimEnd() + `\n${canonicalLine}\n`
  }

  return updated
}
