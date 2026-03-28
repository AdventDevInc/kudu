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

function yaraMatchToThreatFields(match: YaraMatch): {
  detectionName: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  details: string
} {
  return {
    detectionName: match.metadata.detectionName || match.ruleName.replace(/_/g, '.'),
    severity: match.metadata.severity || 'high',
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
})

// ─── YARA rule parsing (integration-style, tests the WASM module) ──

describe('libyara-wasm integration', () => {
  it('matches a simple string rule', async () => {
    const initYara = require('libyara-wasm')
    const yara = await initYara()

    const rules = `
rule Test_Simple {
  meta:
    detectionName = "Test.Simple"
    severity = "medium"
    details = "Test detection"
  strings:
    $a = "malware_test" nocase
  condition:
    $a
}`
    const result = yara.run('this contains MALWARE_TEST data', rules)
    expect(result.matchedRules.size()).toBe(1)
    expect(result.matchedRules.get(0).ruleName).toBe('Test_Simple')

    const meta = result.matchedRules.get(0).metadata
    const metaMap: Record<string, string> = {}
    for (let i = 0; i < meta.size(); i++) {
      const m = meta.get(i)
      metaMap[m.identifier] = m.data
    }
    expect(metaMap.detectionName).toBe('Test.Simple')
    expect(metaMap.severity).toBe('medium')
  })

  it('reports compile errors for invalid rules', async () => {
    const initYara = require('libyara-wasm')
    const yara = await initYara()

    const result = yara.run('data', 'rule bad { invalid syntax here }')
    expect(result.compileErrors.size()).toBeGreaterThan(0)
  })

  it('returns no matches for clean data', async () => {
    const initYara = require('libyara-wasm')
    const yara = await initYara()

    const rules = `
rule Test_NoMatch {
  strings:
    $a = "this_will_not_match_anything"
  condition:
    $a
}`
    const result = yara.run('clean file content', rules)
    expect(result.matchedRules.size()).toBe(0)
  })

  it('supports hash module for SHA-256 matching', async () => {
    const initYara = require('libyara-wasm')
    const crypto = require('crypto')
    const yara = await initYara()

    const testData = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE'
    const hash = crypto.createHash('sha256').update(testData).digest('hex')

    const rules = `
import "hash"
rule Hash_Test {
  meta:
    detectionName = "Test.Hash"
    severity = "low"
  condition:
    hash.sha256(0, filesize) == "${hash}"
}`
    const result = yara.run(testData, rules)
    expect(result.matchedRules.size()).toBe(1)
    expect(result.matchedRules.get(0).ruleName).toBe('Hash_Test')
  })
})
