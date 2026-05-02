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

const MUI_RESOURCE_RE = /^@[^,]+\.(?:dll|exe|mui),-\d+(?:;.*)?$/i
const APPX_RESOURCE_RE = /^@\{[^}]+\?ms-resource:\/\/[^}]+\}$/i

function looksLikeResourceRef(s: string): boolean {
  const t = s.trim()
  return MUI_RESOURCE_RE.test(t) || APPX_RESOURCE_RE.test(t)
}

function isBuiltinRule(args: {
  description: string
  group: string
  isManaged: boolean
  isSystemPath: boolean
}): boolean {
  if (args.isSystemPath) return true
  if (args.isManaged) return true
  return looksLikeResourceRef(args.description) || looksLikeResourceRef(args.group)
}

function classifyRule(raw: {
  programResolved: string
  programExists: boolean
  signature: FirewallSignatureStatus
  profiles: FirewallProfile[]
  localPort: string
  remoteAddress: string
  builtin: boolean
}): { issues: FirewallIssue[]; risk: FirewallRiskLevel } {
  const issues: FirewallIssue[] = []
  const hasProgram = !!raw.programResolved
  if (hasProgram && !raw.programExists) issues.push('stale')

  if (raw.builtin) {
    let risk: FirewallRiskLevel = 'low'
    if (issues.includes('stale')) risk = 'high'
    return { issues, risk }
  }

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

describe('isBuiltinRule', () => {
  const empty = { description: '', group: '', isManaged: false, isSystemPath: false }

  it('detects MUI resource description (FirewallAPI.dll)', () => {
    expect(isBuiltinRule({ ...empty, description: '@FirewallAPI.dll,-25000' })).toBe(true)
  })
  it('detects MUI resource description with trailing semicolon segment', () => {
    expect(isBuiltinRule({ ...empty, description: '@%SystemRoot%\\system32\\firewallapi.dll,-25000;remarks' })).toBe(true)
  })
  it('detects MUI resource for an exe path (Hyper-V vmms.exe)', () => {
    expect(isBuiltinRule({ ...empty, description: '@%systemroot%\\system32\\vmms.exe,-210' })).toBe(true)
  })
  it('detects AppX resource description (Desktop App Web Viewer)', () => {
    const description = '@{Microsoft.Win32WebViewHost_10.0.26100.1_neutral_neutral_cw5n1h2txyewy?ms-resource://Windows.Win32WebViewHost/resources/DisplayName}'
    expect(isBuiltinRule({ ...empty, description })).toBe(true)
  })
  it('detects AppX resource description (Windows Feature Experience Pack)', () => {
    const description = '@{MicrosoftWindows.Client.OOBE_1000.26100.40.0_x64__cw5n1h2txyewy?ms-resource://MicrosoftWindows.Client.OOBE/resources/ProductPkgDisplayName}'
    expect(isBuiltinRule({ ...empty, description })).toBe(true)
  })
  it('treats system-path binaries as built-in even without resource description', () => {
    expect(isBuiltinRule({ ...empty, description: 'Lets stuff through', isSystemPath: true })).toBe(true)
  })
  it('treats managed rules as built-in (Package or Owner SID set — Game Bar / Microsoft Store)', () => {
    // Both Game Bar and Microsoft Store have description resolved to a
    // literal display name. PS sets isManaged=true when the rule has either
    // a non-empty Package SID on the application filter or a non-empty
    // Owner SID on the rule itself — every Store-installed app does.
    expect(isBuiltinRule({ ...empty, description: 'Game Bar', isManaged: true })).toBe(true)
    expect(isBuiltinRule({ ...empty, description: 'Microsoft Store', isManaged: true })).toBe(true)
  })
  it('detects resource ref in Group when description is a resolved literal', () => {
    expect(isBuiltinRule({ ...empty, description: 'Game Bar', group: '@FirewallAPI.dll,-25000' })).toBe(true)
  })
  it('does not match user-installed app descriptions', () => {
    expect(isBuiltinRule({ ...empty, description: 'Steam game server traffic' })).toBe(false)
    expect(isBuiltinRule(empty)).toBe(false)
  })
  it('does not match descriptions that merely start with @ or @{', () => {
    expect(isBuiltinRule({ ...empty, description: '@some random text' })).toBe(false)
    expect(isBuiltinRule({ ...empty, description: '@{not a real resource ref}' })).toBe(false)
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
      builtin: false,
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
      builtin: false,
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
      builtin: false,
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
      builtin: false,
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
      builtin: false,
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
      builtin: true,
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
      builtin: false,
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
      builtin: false,
    })
    expect(issues).toEqual([])
  })

  // Built-in / Microsoft-shipped rules — these are the rules whose default
  // shape (Public + Any/Any) used to produce broad-scope high-risk findings
  // even though removing them breaks Wi-Fi Direct, Core Networking, etc.
  it('does not flag broad-scope on built-in rules', () => {
    const { issues, risk } = classifyRule({
      programResolved: 'C:\\Windows\\System32\\spoolsv.exe',
      programExists: true,
      signature: 'signed',
      profiles: ['Public'],
      localPort: 'Any',
      remoteAddress: 'Any',
      builtin: true,
    })
    expect(issues).toEqual([])
    expect(risk).toBe('low')
  })

  it('does not flag any-remote on built-in port-only rules (e.g. IPv6-In)', () => {
    const { issues, risk } = classifyRule({
      programResolved: '',
      programExists: false,
      signature: 'not-applicable',
      profiles: ['Public'],
      localPort: 'Any',
      remoteAddress: 'Any',
      builtin: true,
    })
    expect(issues).toEqual([])
    expect(risk).toBe('low')
  })

  it('still flags stale on built-in rules (uninstalled feature leftover)', () => {
    const { issues, risk } = classifyRule({
      programResolved: 'C:\\Windows\\System32\\removed.exe',
      programExists: false,
      signature: 'not-applicable',
      profiles: ['Public'],
      localPort: 'Any',
      remoteAddress: 'Any',
      builtin: true,
    })
    expect(issues).toEqual(['stale'])
    expect(risk).toBe('high')
  })
})
