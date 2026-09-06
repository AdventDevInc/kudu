import { describe, it, expect } from 'vitest'
import { updateSysctlConfig, updateSshdConfig, removeSysctlConfigParam } from './config-utils'

// ─── updateSysctlConfig ─────────────────────────────────────

describe('updateSysctlConfig', () => {
  const header = '# test revert instructions'

  it('creates a new file with header when existing is empty', () => {
    const result = updateSysctlConfig('', 'kernel.sysrq', '0', ' = ', header)
    expect(result).toBe(
      '# Kudu system hardening — managed automatically\n' +
      `${header}\n` +
      '\n' +
      'kernel.sysrq = 0\n',
    )
  })

  it('appends to an existing file without duplicating the header', () => {
    const existing =
      '# Kudu system hardening — managed automatically\n' +
      `${header}\n` +
      '\n' +
      'kernel.randomize_va_space = 2\n'
    const result = updateSysctlConfig(existing, 'kernel.sysrq', '0', ' = ', header)
    expect(result).toContain('kernel.randomize_va_space = 2\n')
    expect(result).toContain('kernel.sysrq = 0\n')
    // Header should appear exactly once
    expect(result.match(/Kudu system hardening/g)?.length).toBe(1)
  })

  it('replaces an existing param (spaced format)', () => {
    const existing = 'kernel.sysrq = 1\n'
    const result = updateSysctlConfig(existing, 'kernel.sysrq', '0', ' = ', header)
    expect(result).toBe('kernel.sysrq = 0\n')
    expect(result).not.toContain('= 1')
  })

  it('replaces an existing param (compact format)', () => {
    const existing = 'kernel.sysrq=1\n'
    const result = updateSysctlConfig(existing, 'kernel.sysrq', '0', '=', header)
    expect(result).toBe('kernel.sysrq=0\n')
  })

  it('replaces only the first matching param', () => {
    // Pathological: two lines for the same param
    const existing = 'kernel.sysrq = 1\nkernel.sysrq = 2\n'
    const result = updateSysctlConfig(existing, 'kernel.sysrq', '0', ' = ', header)
    expect(result).toBe('kernel.sysrq = 0\nkernel.sysrq = 2\n')
  })

  it('does not match a param that is a prefix of another', () => {
    const existing = 'net.ipv4.conf.all.accept_redirects = 0\n'
    const result = updateSysctlConfig(existing, 'net.ipv4.conf.all.accept', '1', ' = ', header)
    // Should append, not replace, because `accept` != `accept_redirects`
    expect(result).toContain('net.ipv4.conf.all.accept_redirects = 0')
    expect(result).toContain('net.ipv4.conf.all.accept = 1')
  })

  it('strips trailing blank lines to prevent accumulation', () => {
    const existing = 'kernel.sysrq = 1\n\n\n\n'
    const result = updateSysctlConfig(existing, 'kernel.sysrq', '0', ' = ', header)
    expect(result).toBe('kernel.sysrq = 0\n')
    expect(result).not.toMatch(/\n\n$/)
  })

  it('handles macOS compact separator', () => {
    const result = updateSysctlConfig('', 'net.inet.ip.forwarding', '0', '=', header)
    expect(result).toContain('net.inet.ip.forwarding=0')
  })

  it('handles Linux spaced separator', () => {
    const result = updateSysctlConfig('', 'net.ipv4.ip_forward', '0', ' = ', header)
    expect(result).toContain('net.ipv4.ip_forward = 0')
  })

  it('preserves unrelated lines when replacing', () => {
    const existing =
      '# Custom comment\n' +
      'kernel.randomize_va_space = 2\n' +
      'kernel.sysrq = 1\n' +
      'net.ipv4.ip_forward = 0\n'
    const result = updateSysctlConfig(existing, 'kernel.sysrq', '0', ' = ', header)
    expect(result).toContain('# Custom comment')
    expect(result).toContain('kernel.randomize_va_space = 2')
    expect(result).toContain('kernel.sysrq = 0')
    expect(result).toContain('net.ipv4.ip_forward = 0')
  })

  it('is idempotent — applying the same value twice yields the same result', () => {
    const first = updateSysctlConfig('', 'kernel.sysrq', '0', ' = ', header)
    const second = updateSysctlConfig(first, 'kernel.sysrq', '0', ' = ', header)
    expect(second).toBe(first)
  })
})

describe('removeSysctlConfigParam', () => {
  it('removes the matching param line and keeps others', () => {
    const existing = [
      '# header',
      'kernel.sysrq = 0',
      'net.ipv4.ip_forward = 0',
      '',
    ].join('\n')
    const result = removeSysctlConfigParam(existing, 'kernel.sysrq')
    expect(result).not.toContain('kernel.sysrq')
    expect(result).toContain('net.ipv4.ip_forward = 0')
  })

  it('returns empty when the only param is removed', () => {
    expect(removeSysctlConfigParam('kernel.sysrq = 0\n', 'kernel.sysrq')).toBe('')
  })

  it('removes tab-separated assignments', () => {
    const existing = 'kernel.sysrq\t=\t0\nnet.ipv4.ip_forward = 0\n'
    const result = removeSysctlConfigParam(existing, 'kernel.sysrq')
    expect(result).not.toMatch(/kernel\.sysrq/)
    expect(result).toContain('net.ipv4.ip_forward = 0')
  })
})

// ─── updateSshdConfig ───────────────────────────────────────

describe('updateSshdConfig', () => {
  it('appends directive when not present', () => {
    const content = '# sshd config\nPort 22\n'
    const result = updateSshdConfig(content, 'PermitRootLogin', 'no')
    expect(result).toContain('PermitRootLogin no')
    expect(result).toContain('Port 22')
  })

  it('comments out an active directive and appends canonical', () => {
    const content = 'PermitRootLogin yes\n'
    const result = updateSshdConfig(content, 'PermitRootLogin', 'no')
    expect(result).toContain('# PermitRootLogin yes')
    expect(result).toContain('PermitRootLogin no')
  })

  it('preserves already-correct canonical line (idempotent)', () => {
    const content = 'PermitRootLogin no\n'
    const result = updateSshdConfig(content, 'PermitRootLogin', 'no')
    expect(result).toContain('PermitRootLogin no')
    // Should NOT be commented out
    expect(result).not.toContain('# PermitRootLogin no')
    // Should NOT duplicate the line
    expect(result.match(/PermitRootLogin no/g)?.length).toBe(1)
  })

  it('leaves existing comments untouched', () => {
    const content = '# PermitRootLogin yes\n'
    const result = updateSshdConfig(content, 'PermitRootLogin', 'no')
    // Original comment stays as-is
    expect(result).toContain('# PermitRootLogin yes')
    // Canonical line is appended
    expect(result).toContain('PermitRootLogin no')
  })

  it('comments out multiple active occurrences', () => {
    const content =
      'PermitRootLogin yes\n' +
      'PermitRootLogin without-password\n'
    const result = updateSshdConfig(content, 'PermitRootLogin', 'no')
    expect(result).toContain('# PermitRootLogin yes')
    expect(result).toContain('# PermitRootLogin without-password')
    expect(result).toContain('PermitRootLogin no')
  })

  it('handles directive with indentation', () => {
    const content = '  PermitRootLogin yes\n'
    const result = updateSshdConfig(content, 'PermitRootLogin', 'no')
    expect(result).toContain('# PermitRootLogin yes')
    expect(result).toContain('PermitRootLogin no')
  })

  it('does not match a directive that is a prefix of another', () => {
    const content = 'PermitRootLoginExtra yes\n'
    const result = updateSshdConfig(content, 'PermitRootLogin', 'no')
    // Should NOT comment out the non-matching directive
    expect(result).toContain('PermitRootLoginExtra yes')
    expect(result).not.toContain('# PermitRootLoginExtra')
  })

  it('handles mixed commented and active lines', () => {
    const content =
      '# PermitRootLogin prohibit-password\n' +
      'PermitRootLogin yes\n'
    const result = updateSshdConfig(content, 'PermitRootLogin', 'no')
    // Comment stays as comment
    expect(result).toContain('# PermitRootLogin prohibit-password')
    // Active line gets commented out
    expect(result).toContain('# PermitRootLogin yes')
    // Canonical appended
    expect(result).toContain('PermitRootLogin no')
  })

  it('is idempotent — applying twice yields the same result', () => {
    const content = 'PermitRootLogin yes\nPasswordAuthentication yes\n'
    const first = updateSshdConfig(content, 'PermitRootLogin', 'no')
    const second = updateSshdConfig(first, 'PermitRootLogin', 'no')
    expect(second).toBe(first)
  })

  it('handles PasswordAuthentication directive', () => {
    const content = 'PasswordAuthentication yes\n'
    const result = updateSshdConfig(content, 'PasswordAuthentication', 'no')
    expect(result).toContain('# PasswordAuthentication yes')
    expect(result).toContain('PasswordAuthentication no')
  })

  it('preserves unrelated directives', () => {
    const content =
      'Port 22\n' +
      'PermitRootLogin yes\n' +
      'AllowUsers admin\n'
    const result = updateSshdConfig(content, 'PermitRootLogin', 'no')
    expect(result).toContain('Port 22')
    expect(result).toContain('AllowUsers admin')
  })

  it('handles empty config', () => {
    const result = updateSshdConfig('', 'PermitRootLogin', 'no')
    expect(result).toContain('PermitRootLogin no')
  })
})
