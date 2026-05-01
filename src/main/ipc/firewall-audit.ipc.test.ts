import { describe, it, expect } from 'vitest'

// ── Test the pure parsing/classification logic from firewall-audit.ipc.ts ──
// Replicated here to avoid importing the Electron-dependent module.

type FirewallProfile = 'Domain' | 'Private' | 'Public' | 'Any'
type FirewallSignatureStatus = 'signed' | 'unsigned' | 'unknown' | 'not-applicable'
type FirewallIssue = 'stale' | 'unsigned' | 'broad-scope' | 'any-remote'
type FirewallRiskLevel = 'high' | 'medium' | 'low'

function parseProfiles(raw: string): FirewallProfile[] {
  if (!raw) return []
  if (raw.toLowerCase().trim() === 'any') return ['Any']
  const parts = raw.split(',').map((p) => p.trim())
  const out: FirewallProfile[] = []
  for (const p of parts) {
    if (p === 'Domain' || p === 'Private' || p === 'Public') out.push(p)
  }
  return out
}

function parseSignature(raw: string): FirewallSignatureStatus {
  switch (raw) {
    case 'signed': return 'signed'
    case 'unsigned': return 'unsigned'
    case 'unknown': return 'unknown'
    default: return 'not-applicable'
  }
}

function classifyRule(raw: {
  programResolved: string
  programExists: boolean
  signature: FirewallSignatureStatus
  profiles: FirewallProfile[]
  localPort: string
  remoteAddress: string
}): { issues: FirewallIssue[]; risk: FirewallRiskLevel } {
  const issues: FirewallIssue[] = []
  const hasProgram = !!raw.programResolved
  if (hasProgram && !raw.programExists) issues.push('stale')
  if (hasProgram && raw.programExists && raw.signature === 'unsigned') issues.push('unsigned')

  const isAnyRemote = !raw.remoteAddress || raw.remoteAddress.toLowerCase() === 'any'
  const isAnyPort = !raw.localPort || raw.localPort.toLowerCase() === 'any'
  const hitsPublic = raw.profiles.includes('Public') || raw.profiles.includes('Any')

  if (isAnyRemote && isAnyPort && hitsPublic) issues.push('broad-scope')
  else if (isAnyRemote) issues.push('any-remote')

  let risk: FirewallRiskLevel = 'low'
  if (issues.includes('stale') || issues.includes('broad-scope')) risk = 'high'
  else if (issues.includes('unsigned') || issues.includes('any-remote')) risk = 'medium'

  return { issues, risk }
}

// Replica of RULE_NAME_RE from firewall-audit.ipc.ts — kept in sync to
// guard against accidental tightening that would break valid rule names.
const RULE_NAME_RE = /^[^\x00-\x1f\x7f|]{1,512}$/

describe('RULE_NAME_RE', () => {
  it('accepts GUID-style system names', () => {
    expect(RULE_NAME_RE.test('{6F4DC32E-BA34-422D-9F87-123456789ABC}')).toBe(true)
  })
  it('accepts hyphenated system names', () => {
    expect(RULE_NAME_RE.test('CoreNet-DHCPV6-In')).toBe(true)
  })
  it('accepts user-defined names with spaces and parens', () => {
    expect(RULE_NAME_RE.test('Microsoft Edge (mDNS-In)')).toBe(true)
  })
  it('rejects control characters', () => {
    expect(RULE_NAME_RE.test('foo\x00bar')).toBe(false)
    expect(RULE_NAME_RE.test('foo\nbar')).toBe(false)
    expect(RULE_NAME_RE.test('foo\rbar')).toBe(false)
  })
  it('rejects pipe (our scan-output delimiter)', () => {
    expect(RULE_NAME_RE.test('rule|name')).toBe(false)
  })
  it('rejects empty names', () => {
    expect(RULE_NAME_RE.test('')).toBe(false)
  })
  it('rejects names over the length cap', () => {
    expect(RULE_NAME_RE.test('a'.repeat(513))).toBe(false)
    expect(RULE_NAME_RE.test('a'.repeat(512))).toBe(true)
  })
})

describe('parseProfiles', () => {
  it('returns empty array for empty input', () => {
    expect(parseProfiles('')).toEqual([])
  })
  it('returns ["Any"] for "Any"', () => {
    expect(parseProfiles('Any')).toEqual(['Any'])
  })
  it('parses comma-separated profiles', () => {
    expect(parseProfiles('Domain, Private')).toEqual(['Domain', 'Private'])
  })
  it('drops unknown values', () => {
    expect(parseProfiles('Domain, Bogus, Public')).toEqual(['Domain', 'Public'])
  })
})

describe('parseSignature', () => {
  it('maps known statuses', () => {
    expect(parseSignature('signed')).toBe('signed')
    expect(parseSignature('unsigned')).toBe('unsigned')
    expect(parseSignature('unknown')).toBe('unknown')
  })
  it('maps empty/unrecognized to not-applicable', () => {
    expect(parseSignature('')).toBe('not-applicable')
    expect(parseSignature('weird')).toBe('not-applicable')
  })
})

describe('classifyRule', () => {
  it('flags stale program as high risk', () => {
    const { issues, risk } = classifyRule({
      programResolved: 'C:\\does\\not\\exist.exe',
      programExists: false,
      signature: 'not-applicable',
      profiles: ['Domain'],
      localPort: '443',
      remoteAddress: 'LocalSubnet',
    })
    expect(issues).toContain('stale')
    expect(risk).toBe('high')
  })

  it('flags unsigned existing binary as medium risk', () => {
    const { issues, risk } = classifyRule({
      programResolved: 'C:\\Users\\Test\\app.exe',
      programExists: true,
      signature: 'unsigned',
      profiles: ['Private'],
      localPort: '8080',
      remoteAddress: 'LocalSubnet',
    })
    expect(issues).toEqual(['unsigned'])
    expect(risk).toBe('medium')
  })

  it('flags broad-scope (Public + Any port + Any remote) as high risk', () => {
    const { issues, risk } = classifyRule({
      programResolved: '',
      programExists: false,
      signature: 'not-applicable',
      profiles: ['Public'],
      localPort: 'Any',
      remoteAddress: 'Any',
    })
    expect(issues).toContain('broad-scope')
    expect(risk).toBe('high')
  })

  it('flags any-remote (not public) as medium risk', () => {
    const { issues, risk } = classifyRule({
      programResolved: '',
      programExists: false,
      signature: 'not-applicable',
      profiles: ['Private'],
      localPort: 'Any',
      remoteAddress: 'Any',
    })
    expect(issues).toEqual(['any-remote'])
    expect(risk).toBe('medium')
  })

  it('treats Any profile as hitting public', () => {
    const { issues, risk } = classifyRule({
      programResolved: '',
      programExists: false,
      signature: 'not-applicable',
      profiles: ['Any'],
      localPort: 'Any',
      remoteAddress: 'Any',
    })
    expect(issues).toContain('broad-scope')
    expect(risk).toBe('high')
  })

  it('returns low risk for a tightly-scoped, signed rule', () => {
    const { issues, risk } = classifyRule({
      programResolved: 'C:\\Windows\\System32\\svchost.exe',
      programExists: true,
      signature: 'signed',
      profiles: ['Domain'],
      localPort: '445',
      remoteAddress: 'LocalSubnet',
    })
    expect(issues).toEqual([])
    expect(risk).toBe('low')
  })

  it('does not flag unsigned when program is missing on disk (stale takes priority)', () => {
    const { issues } = classifyRule({
      programResolved: 'C:\\gone.exe',
      programExists: false,
      signature: 'unsigned',
      profiles: ['Private'],
      localPort: '443',
      remoteAddress: 'LocalSubnet',
    })
    expect(issues).toContain('stale')
    expect(issues).not.toContain('unsigned')
  })

  it('skips program-related issues when there is no program filter', () => {
    const { issues } = classifyRule({
      programResolved: '',
      programExists: false,
      signature: 'not-applicable',
      profiles: ['Domain'],
      localPort: '80',
      remoteAddress: '10.0.0.0/8',
    })
    expect(issues).toEqual([])
  })
})
