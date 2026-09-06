/**
 * Pure text-manipulation utilities for system config files.
 * Shared by Linux and macOS hardening code.
 *
 * These functions operate on strings (file contents) and return strings,
 * making them easy to unit-test without mocking the file system.
 */

// ─── Sysctl config editing ─────────────────────────────────

const SYSCTL_HEADER = [
  '# Kudu system hardening — managed automatically',
]

/**
 * Update sysctl config file contents by setting `param` to `value`.
 * - Replaces an existing line for the same param (with or without spaces around `=`)
 * - Appends if not found, adding a header comment if the file is new
 * - `separator` controls the format: `' = '` for Linux, `'='` for macOS
 * - `headerExtra` is the second comment line (platform-specific revert instructions)
 */
export function updateSysctlConfig(
  existing: string,
  param: string,
  value: string,
  separator: string,
  headerExtra: string,
): string {
  const lines = existing.split('\n')
  // Strip trailing blank lines to prevent accumulation
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()

  const newLine = `${param}${separator}${value}`
  let found = false
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart()
    if (trimmed.startsWith(`${param}=`) || trimmed.startsWith(`${param} =`)) {
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
  const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const assignment = new RegExp(`^\\s*${escaped}\\s*=`)
  const lines = existing.split('\n').filter((line) => !assignment.test(line))
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length === 0) return ''
  return lines.join('\n') + '\n'
}

// ─── SSH config editing ─────────────────────────────────────

/**
 * Update sshd_config contents by setting `directive` to `value`.
 * - Comments out ALL existing occurrences of the directive (active or commented)
 * - Preserves lines that already match the exact canonical value (idempotent)
 * - Appends the canonical line if no matching uncommented line exists
 */
export function updateSshdConfig(
  content: string,
  directive: string,
  value: string,
): string {
  const canonicalLine = `${directive} ${value}`
  const pattern = new RegExp(`^(\\s*#?\\s*${directive}\\s.*)$`, 'gm')

  // Comment out every existing occurrence, except lines that already match
  // the exact canonical value (keeps the file idempotent on repeated applies)
  let updated = content.replace(pattern, (match) => {
    const trimmed = match.trimStart()
    if (trimmed === canonicalLine) return match
    return trimmed.startsWith('#') ? match : `# ${trimmed}`
  })

  // Only append if no uncommented canonical line exists
  const hasCanonical = new RegExp(`^\\s*${directive}\\s+${value}\\s*$`, 'm').test(updated)
  if (!hasCanonical) {
    updated = updated.trimEnd() + `\n${canonicalLine}\n`
  }

  return updated
}
