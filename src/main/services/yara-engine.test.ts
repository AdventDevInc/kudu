import { describe, it, expect } from 'vitest'

// ─── Test pure conversion logic (replicated to avoid Electron imports) ───

interface YaraMatch {
  ruleName: string
  metadata: {
    detectionName?: string
    severity?: 'critical' | 'high' | 'medium' | 'low'
    details?: string
    filenameOnly?: string
  }
  matchedStrings: string[]
}

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low'] as const)

function yaraMatchToThreatFields(match: YaraMatch): {
  detectionName: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  details: string
} {
  const rawSeverity = match.metadata.severity
  const severity = rawSeverity && VALID_SEVERITIES.has(rawSeverity) ? rawSeverity : 'high'
  return {
    detectionName: match.metadata.detectionName || match.ruleName.replace(/_/g, '.'),
    severity,
    details: match.metadata.details || `YARA rule match: ${match.ruleName}`,
  }
}

// ─── yaraMatchToThreatFields ─────────────────────────────────────

describe('yaraMatchToThreatFields', () => {
  it('uses metadata fields when available', () => {
    const match: YaraMatch = {
      ruleName: 'CoinMiner_XMRig',
      metadata: {
        detectionName: 'CoinMiner.XMRig',
        severity: 'critical',
        details: 'XMRig cryptocurrency miner',
      },
      matchedStrings: ['xmrig'],
    }
    const result = yaraMatchToThreatFields(match)
    expect(result.detectionName).toBe('CoinMiner.XMRig')
    expect(result.severity).toBe('critical')
    expect(result.details).toBe('XMRig cryptocurrency miner')
  })

  it('falls back to rule name for detectionName when metadata missing', () => {
    const match: YaraMatch = {
      ruleName: 'CoinMiner_XMRig',
      metadata: {},
      matchedStrings: [],
    }
    const result = yaraMatchToThreatFields(match)
    expect(result.detectionName).toBe('CoinMiner.XMRig')
  })

  it('converts underscores to dots in rule name fallback', () => {
    const match: YaraMatch = {
      ruleName: 'Trojan_AgentTesla_Variant',
      metadata: {},
      matchedStrings: [],
    }
    const result = yaraMatchToThreatFields(match)
    expect(result.detectionName).toBe('Trojan.AgentTesla.Variant')
  })

  it('defaults severity to high when metadata missing', () => {
    const match: YaraMatch = {
      ruleName: 'Test',
      metadata: {},
      matchedStrings: [],
    }
    const result = yaraMatchToThreatFields(match)
    expect(result.severity).toBe('high')
  })

  it('defaults details to YARA rule match message', () => {
    const match: YaraMatch = {
      ruleName: 'RAT_DarkComet',
      metadata: {},
      matchedStrings: [],
    }
    const result = yaraMatchToThreatFields(match)
    expect(result.details).toBe('YARA rule match: RAT_DarkComet')
  })

  it('handles all severity levels', () => {
    for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
      const match: YaraMatch = {
        ruleName: 'Test',
        metadata: { severity: sev },
        matchedStrings: [],
      }
      expect(yaraMatchToThreatFields(match).severity).toBe(sev)
    }
  })

  it('clamps invalid severity to high', () => {
    const match: YaraMatch = {
      ruleName: 'Test',
      metadata: { severity: 'info' as any },
      matchedStrings: [],
    }
    expect(yaraMatchToThreatFields(match).severity).toBe('high')
  })
})

// ─── @litko/yara-x integration tests ────────────────────────────

describe('@litko/yara-x integration', () => {
  it('compiles rules and scans a matching buffer', () => {
    const yarax = require('@litko/yara-x')
    const scanner = yarax.create()
    scanner.addRuleSource(`
rule Test_Simple {
  meta:
    detectionName = "Test.Simple"
    severity = "medium"
    details = "Test detection"
  strings:
    $a = "malware_test" nocase
  condition:
    $a
}`)
    const results = scanner.scan(Buffer.from('this contains MALWARE_TEST data'))
    expect(results.length).toBe(1)
    expect(results[0].ruleIdentifier).toBe('Test_Simple')
    expect(results[0].meta.detectionName).toBe('Test.Simple')
    expect(results[0].meta.severity).toBe('medium')
  })

  it('throws on invalid rule syntax', () => {
    const yarax = require('@litko/yara-x')
    const scanner = yarax.create()
    expect(() => scanner.addRuleSource('rule bad { invalid syntax }')).toThrow()
  })

  it('returns empty array for clean data', () => {
    const yarax = require('@litko/yara-x')
    const scanner = yarax.create()
    scanner.addRuleSource('rule NoMatch { strings: $a = "wontmatch" condition: $a }')
    const results = scanner.scan(Buffer.from('clean file content'))
    expect(results.length).toBe(0)
  })

  it('preserves binary bytes correctly', () => {
    const yarax = require('@litko/yara-x')
    const scanner = yarax.create()
    scanner.addRuleSource('rule HexPattern { strings: $h = { 4D 5A 90 00 } condition: $h }')
    const pe = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00])
    const results = scanner.scan(pe)
    expect(results.length).toBe(1)
  })

  it('scans multiple times with compiled rules (no recompilation)', () => {
    const yarax = require('@litko/yara-x')
    const scanner = yarax.create()
    scanner.addRuleSource('rule Multi { strings: $a = "target" condition: $a }')

    const clean = scanner.scan(Buffer.from('nothing here'))
    expect(clean.length).toBe(0)

    const match = scanner.scan(Buffer.from('has target inside'))
    expect(match.length).toBe(1)

    // Scan again — should still work (rules not recompiled)
    const match2 = scanner.scan(Buffer.from('another target file'))
    expect(match2.length).toBe(1)
  })
})
