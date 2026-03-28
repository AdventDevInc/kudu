import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'

// ─── Replicate pure validation logic to avoid Electron imports ───

const MAX_RULE_CONTENT_BYTES = 1 * 1024 * 1024
const MAX_RULE_COUNT = 10_000

interface YaraRuleFile {
  filename: string
  content: string
}

interface YaraRuleBundle {
  version: string
  updatedAt: string
  sha256: string
  rules: YaraRuleFile[]
}

function validateRuleBundle(raw: unknown): YaraRuleBundle | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null

  const obj = raw as Record<string, unknown>
  if (typeof obj.version !== 'string' || obj.version.length === 0 || obj.version.length > 100) return null
  if (typeof obj.updatedAt !== 'string' || obj.updatedAt.length === 0 || obj.updatedAt.length > 100) return null
  if (typeof obj.sha256 !== 'string' || obj.sha256.length === 0 || obj.sha256.length > 128) return null

  if (!Array.isArray(obj.rules) || obj.rules.length === 0 || obj.rules.length > MAX_RULE_COUNT) return null

  const rules: YaraRuleFile[] = []
  for (const item of obj.rules) {
    if (typeof item !== 'object' || item === null) return null
    const entry = item as Record<string, unknown>
    if (typeof entry.filename !== 'string' || !entry.filename.endsWith('.yar')) return null
    if (typeof entry.content !== 'string' || entry.content.length === 0) return null
    if (entry.content.length > MAX_RULE_CONTENT_BYTES) return null
    if (entry.filename.includes('/') || entry.filename.includes('\\') || entry.filename.includes('..')) return null
    rules.push({ filename: entry.filename, content: entry.content })
  }

  return {
    version: obj.version,
    updatedAt: obj.updatedAt,
    sha256: obj.sha256,
    rules,
  }
}

function computeBundleHash(rules: YaraRuleFile[]): string {
  const sorted = [...rules].sort((a, b) => a.filename.localeCompare(b.filename))
  const combined = sorted.map(r => r.content).join('')
  return createHash('sha256').update(combined).digest('hex')
}

// ─── validateRuleBundle ──────────────────────────────────────

describe('validateRuleBundle', () => {
  const validBundle = {
    version: '1.0.0',
    updatedAt: '2026-03-28T12:00:00Z',
    sha256: 'abc123',
    rules: [
      { filename: 'miners.yar', content: 'rule Test { condition: true }' },
    ],
  }

  it('accepts a valid bundle', () => {
    expect(validateRuleBundle(validBundle)).not.toBeNull()
  })

  it('returns correct fields', () => {
    const result = validateRuleBundle(validBundle)!
    expect(result.version).toBe('1.0.0')
    expect(result.updatedAt).toBe('2026-03-28T12:00:00Z')
    expect(result.sha256).toBe('abc123')
    expect(result.rules).toHaveLength(1)
    expect(result.rules[0].filename).toBe('miners.yar')
  })

  it('rejects null', () => {
    expect(validateRuleBundle(null)).toBeNull()
  })

  it('rejects arrays', () => {
    expect(validateRuleBundle([1, 2, 3])).toBeNull()
  })

  it('rejects non-objects', () => {
    expect(validateRuleBundle('string')).toBeNull()
    expect(validateRuleBundle(42)).toBeNull()
  })

  it('rejects missing version', () => {
    const { version, ...rest } = validBundle
    expect(validateRuleBundle(rest)).toBeNull()
  })

  it('rejects empty version', () => {
    expect(validateRuleBundle({ ...validBundle, version: '' })).toBeNull()
  })

  it('rejects missing updatedAt', () => {
    const { updatedAt, ...rest } = validBundle
    expect(validateRuleBundle(rest)).toBeNull()
  })

  it('rejects missing sha256', () => {
    const { sha256, ...rest } = validBundle
    expect(validateRuleBundle(rest)).toBeNull()
  })

  it('rejects empty rules array', () => {
    expect(validateRuleBundle({ ...validBundle, rules: [] })).toBeNull()
  })

  it('rejects non-array rules', () => {
    expect(validateRuleBundle({ ...validBundle, rules: 'not an array' })).toBeNull()
  })

  it('rejects rules without .yar extension', () => {
    expect(validateRuleBundle({
      ...validBundle,
      rules: [{ filename: 'test.txt', content: 'rule Test { condition: true }' }],
    })).toBeNull()
  })

  it('rejects rules with empty content', () => {
    expect(validateRuleBundle({
      ...validBundle,
      rules: [{ filename: 'test.yar', content: '' }],
    })).toBeNull()
  })

  it('rejects path traversal in filename', () => {
    expect(validateRuleBundle({
      ...validBundle,
      rules: [{ filename: '../evil.yar', content: 'rule X { condition: true }' }],
    })).toBeNull()
    expect(validateRuleBundle({
      ...validBundle,
      rules: [{ filename: 'sub/test.yar', content: 'rule X { condition: true }' }],
    })).toBeNull()
    expect(validateRuleBundle({
      ...validBundle,
      rules: [{ filename: 'sub\\test.yar', content: 'rule X { condition: true }' }],
    })).toBeNull()
  })

  it('rejects rules exceeding content size limit', () => {
    expect(validateRuleBundle({
      ...validBundle,
      rules: [{ filename: 'big.yar', content: 'x'.repeat(MAX_RULE_CONTENT_BYTES + 1) }],
    })).toBeNull()
  })

  it('accepts rules at the content size limit', () => {
    expect(validateRuleBundle({
      ...validBundle,
      rules: [{ filename: 'big.yar', content: 'x'.repeat(MAX_RULE_CONTENT_BYTES) }],
    })).not.toBeNull()
  })
})

// ─── computeBundleHash ───────────────────────────────────────

describe('computeBundleHash', () => {
  it('produces consistent hashes for the same content', () => {
    const rules: YaraRuleFile[] = [
      { filename: 'a.yar', content: 'rule A { condition: true }' },
      { filename: 'b.yar', content: 'rule B { condition: true }' },
    ]
    expect(computeBundleHash(rules)).toBe(computeBundleHash(rules))
  })

  it('sorts by filename before hashing (order-independent)', () => {
    const rules1: YaraRuleFile[] = [
      { filename: 'b.yar', content: 'rule B { condition: true }' },
      { filename: 'a.yar', content: 'rule A { condition: true }' },
    ]
    const rules2: YaraRuleFile[] = [
      { filename: 'a.yar', content: 'rule A { condition: true }' },
      { filename: 'b.yar', content: 'rule B { condition: true }' },
    ]
    expect(computeBundleHash(rules1)).toBe(computeBundleHash(rules2))
  })

  it('produces different hashes for different content', () => {
    const rules1: YaraRuleFile[] = [
      { filename: 'a.yar', content: 'rule A { condition: true }' },
    ]
    const rules2: YaraRuleFile[] = [
      { filename: 'a.yar', content: 'rule B { condition: false }' },
    ]
    expect(computeBundleHash(rules1)).not.toBe(computeBundleHash(rules2))
  })

  it('returns a valid SHA-256 hex string', () => {
    const rules: YaraRuleFile[] = [
      { filename: 'test.yar', content: 'rule Test { condition: true }' },
    ]
    const hash = computeBundleHash(rules)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ─── Integrity verification ──────────────────────────────────

describe('bundle integrity verification', () => {
  it('validates correctly when sha256 matches computed hash', () => {
    const rules: YaraRuleFile[] = [
      { filename: 'test.yar', content: 'rule Test { condition: true }' },
    ]
    const sha256 = computeBundleHash(rules)
    const bundle = validateRuleBundle({
      version: '1.0.0',
      updatedAt: '2026-03-28T12:00:00Z',
      sha256,
      rules,
    })
    expect(bundle).not.toBeNull()
    expect(computeBundleHash(bundle!.rules)).toBe(sha256)
  })

  it('detects tampered content via hash mismatch', () => {
    const rules: YaraRuleFile[] = [
      { filename: 'test.yar', content: 'rule Test { condition: true }' },
    ]
    const sha256 = computeBundleHash(rules)
    // Tamper with the content
    const tamperedRules: YaraRuleFile[] = [
      { filename: 'test.yar', content: 'rule Malicious { condition: true }' },
    ]
    expect(computeBundleHash(tamperedRules)).not.toBe(sha256)
  })
})

// ─── Metadata validation ─────────────────────────────────────

describe('metadata validation', () => {
  function validateMetadata(raw: unknown): boolean {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
    const obj = raw as Record<string, unknown>
    return (
      typeof obj.version === 'string' && obj.version.length > 0 && obj.version.length <= 100 &&
      typeof obj.updatedAt === 'string' && obj.updatedAt.length > 0 && obj.updatedAt.length <= 100 &&
      typeof obj.rulesCount === 'number' && obj.rulesCount >= 0 &&
      typeof obj.sha256 === 'string' && obj.sha256.length > 0 && obj.sha256.length <= 128
    )
  }

  it('accepts valid metadata', () => {
    expect(validateMetadata({
      version: '1.0.0',
      updatedAt: '2026-03-28T12:00:00Z',
      rulesCount: 50,
      sha256: 'abc123',
    })).toBe(true)
  })

  it('rejects null', () => {
    expect(validateMetadata(null)).toBe(false)
  })

  it('rejects missing version', () => {
    expect(validateMetadata({
      updatedAt: '2026-03-28T12:00:00Z',
      rulesCount: 50,
      sha256: 'abc123',
    })).toBe(false)
  })

  it('rejects empty version', () => {
    expect(validateMetadata({
      version: '',
      updatedAt: '2026-03-28T12:00:00Z',
      rulesCount: 50,
      sha256: 'abc123',
    })).toBe(false)
  })

  it('rejects negative rulesCount', () => {
    expect(validateMetadata({
      version: '1.0.0',
      updatedAt: '2026-03-28T12:00:00Z',
      rulesCount: -1,
      sha256: 'abc123',
    })).toBe(false)
  })

  it('rejects non-number rulesCount', () => {
    expect(validateMetadata({
      version: '1.0.0',
      updatedAt: '2026-03-28T12:00:00Z',
      rulesCount: '50',
      sha256: 'abc123',
    })).toBe(false)
  })
})
