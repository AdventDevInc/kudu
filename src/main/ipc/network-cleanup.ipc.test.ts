import { describe, it, expect } from 'vitest'

// ── Test the pure logic from network-cleanup.ipc.ts ──
// Replicated here to avoid importing the Electron-dependent module.

// ── Network item type validation ──

const VALID_NETWORK_ITEM_TYPES = ['dns-cache', 'wifi-profile', 'arp-cache', 'network-history']

describe('network item types', () => {
  it('has exactly 4 known types', () => {
    expect(VALID_NETWORK_ITEM_TYPES).toHaveLength(4)
  })

  it('includes dns-cache', () => {
    expect(VALID_NETWORK_ITEM_TYPES).toContain('dns-cache')
  })

  it('includes wifi-profile', () => {
    expect(VALID_NETWORK_ITEM_TYPES).toContain('wifi-profile')
  })

  it('includes arp-cache', () => {
    expect(VALID_NETWORK_ITEM_TYPES).toContain('arp-cache')
  })

  it('includes network-history', () => {
    expect(VALID_NETWORK_ITEM_TYPES).toContain('network-history')
  })
})

// ── WiFi profile label validation (mirrors cleanNetworkItems) ──

function isValidWifiProfileLabel(label: string | undefined | null): boolean {
  if (!label || /["\x00-\x1f]/.test(label)) return false
  return true
}

describe('wifi profile label validation', () => {
  it('accepts normal profile names', () => {
    expect(isValidWifiProfileLabel('MyHomeWifi')).toBe(true)
    expect(isValidWifiProfileLabel('Office Network 5GHz')).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isValidWifiProfileLabel('')).toBe(false)
  })

  it('rejects null/undefined', () => {
    expect(isValidWifiProfileLabel(null)).toBe(false)
    expect(isValidWifiProfileLabel(undefined)).toBe(false)
  })

  it('rejects names with double quotes (injection risk)', () => {
    expect(isValidWifiProfileLabel('evil"network')).toBe(false)
  })

  it('rejects names with control characters', () => {
    expect(isValidWifiProfileLabel('evil\x00network')).toBe(false)
    expect(isValidWifiProfileLabel('evil\x0Anetwork')).toBe(false)
    expect(isValidWifiProfileLabel('evil\x1Fnetwork')).toBe(false)
  })

  it('accepts names with special characters (non-control)', () => {
    expect(isValidWifiProfileLabel("Bob's WiFi")).toBe(true)
    expect(isValidWifiProfileLabel('Cafe @ Corner')).toBe(true)
  })
})

// ── Network history GUID extraction (mirrors cleanNetworkItems) ──

function extractGuidFromDetail(detail: string): string | null {
  const guidMatch = detail.match(/(\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\})/)
  return guidMatch ? guidMatch[1] : null
}

describe('network history GUID extraction', () => {
  it('extracts valid GUID from detail string', () => {
    expect(extractGuidFromDetail('Saved network profile · {ABC12345-1234-5678-9ABC-DEF012345678}'))
      .toBe('{ABC12345-1234-5678-9ABC-DEF012345678}')
  })

  it('returns null when no GUID present', () => {
    expect(extractGuidFromDetail('Some detail without guid')).toBe(null)
  })

  it('returns null for malformed GUID', () => {
    expect(extractGuidFromDetail('profile · {not-a-guid}')).toBe(null)
    expect(extractGuidFromDetail('profile · {12345}')).toBe(null)
  })

  it('extracts GUID regardless of surrounding text', () => {
    expect(extractGuidFromDetail('prefix {aabbccdd-1122-3344-5566-778899aabbcc} suffix'))
      .toBe('{aabbccdd-1122-3344-5566-778899aabbcc}')
  })

  it('rejects GUID with injection characters', () => {
    // The regex pattern only allows hex digits and dashes inside braces
    expect(extractGuidFromDetail('profile · {ABCD1234-ZZZZ-5678-9ABC-DEF012345678}')).toBe(null)
  })
})

// ── validateStringArray (replica) ──

function validateStringArray(
  input: unknown,
  maxItems: number = 10_000,
  maxItemLength: number = 1024
): string[] | null {
  if (!Array.isArray(input)) return null
  if (input.length > maxItems) return null
  if (!input.every((v: unknown) => typeof v === 'string' && v.length <= maxItemLength)) return null
  return input as string[]
}

describe('NETWORK_CLEAN input validation', () => {
  it('rejects non-array input', () => {
    expect(validateStringArray(null)).toBe(null)
    expect(validateStringArray('string')).toBe(null)
    expect(validateStringArray(42)).toBe(null)
  })

  it('accepts valid string array of item IDs', () => {
    expect(validateStringArray(['id-1', 'id-2'])).toEqual(['id-1', 'id-2'])
  })

  it('accepts empty array', () => {
    expect(validateStringArray([])).toEqual([])
  })

  it('rejects array with non-string elements', () => {
    expect(validateStringArray([1, 'valid'])).toBe(null)
  })

  it('rejects oversized arrays', () => {
    const huge = Array.from({ length: 10_001 }, (_, i) => `id-${i}`)
    expect(validateStringArray(huge)).toBe(null)
  })

  it('rejects strings exceeding max item length', () => {
    expect(validateStringArray(['x'.repeat(1025)])).toBe(null)
  })
})

// ── Scan session management ──

describe('scan session management', () => {
  it('limits to 3 sessions (oldest evicted)', () => {
    const scanSessions = new Map<string, Map<string, unknown>>()
    for (let i = 0; i < 5; i++) {
      scanSessions.set(`scan-${i}`, new Map([['item-1', { id: 'item-1' }]]))
    }
    const sessionKeys = [...scanSessions.keys()]
    while (sessionKeys.length > 3) scanSessions.delete(sessionKeys.shift()!)

    expect(scanSessions.size).toBe(3)
    expect(scanSessions.has('scan-0')).toBe(false)
    expect(scanSessions.has('scan-1')).toBe(false)
    expect(scanSessions.has('scan-4')).toBe(true)
  })

  it('looks up items across all sessions', () => {
    const session1 = new Map([['id-a', { id: 'id-a', type: 'dns-cache' }]])
    const session2 = new Map([['id-b', { id: 'id-b', type: 'arp-cache' }]])
    const scanSessions = new Map<string, Map<string, any>>([
      ['s1', session1],
      ['s2', session2]
    ])

    const requestedIds = ['id-a', 'id-b', 'id-nonexistent']
    const items: any[] = []
    for (const id of requestedIds) {
      for (const session of scanSessions.values()) {
        const item = session.get(id)
        if (item) { items.push(item); break }
      }
    }

    expect(items).toHaveLength(2)
    expect(items[0].type).toBe('dns-cache')
    expect(items[1].type).toBe('arp-cache')
  })
})

// ── Clean result structure ──

describe('clean result structure', () => {
  it('has correct shape with cleaned, failed, and details', () => {
    const result = { cleaned: 2, failed: 1, details: ['Flushed DNS', 'Cleared ARP', 'Failed: WiFi'] }
    expect(result.cleaned).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.details).toHaveLength(3)
  })

  it('returns empty result when no items provided', () => {
    const result = { cleaned: 0, failed: 0, details: [] as string[] }
    expect(result.cleaned).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.details).toHaveLength(0)
  })
})

// ── ARP parsing logic ──

describe('ARP entry counting', () => {
  it('counts lines with IP addresses', () => {
    const stdout = [
      'Interface: 192.168.1.1 --- 0x4',
      '  Internet Address      Physical Address      Type',
      '  192.168.1.1            aa-bb-cc-dd-ee-ff     dynamic',
      '  192.168.1.100          11-22-33-44-55-66     dynamic',
      '  10.0.0.1               ff-ee-dd-cc-bb-aa     static',
      ''
    ].join('\n')

    const lines = stdout.split('\n').filter((l) => /\d+\.\d+\.\d+\.\d+/.test(l))
    expect(lines.length).toBe(4) // interface line + 3 entries
  })

  it('returns 0 for empty output', () => {
    const lines = ''.split('\n').filter((l) => /\d+\.\d+\.\d+\.\d+/.test(l))
    expect(lines.length).toBe(0)
  })
})

// ── Network history parsing (Windows registry output) ──

describe('network history parsing', () => {
  it('parses GUID and ProfileName from registry output', () => {
    const stdout = [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\NetworkList\\Profiles\\{AABBCCDD-1122-3344-5566-778899AABBCC}',
      '    ProfileName    REG_SZ    My Home Network',
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\NetworkList\\Profiles\\{11223344-5566-7788-99AA-BBCCDDEEFF00}',
      '    ProfileName    REG_SZ    Office WiFi',
      ''
    ].join('\n')

    const entries: { name: string; guid: string }[] = []
    let currentGuid = ''
    for (const line of stdout.split('\n')) {
      const guidMatch = line.match(/\\(\{[0-9A-F-]+\})$/i)
      if (guidMatch) {
        currentGuid = guidMatch[1]
      }
      const nameMatch = line.match(/ProfileName\s+REG_SZ\s+(.+)/i)
      if (nameMatch && currentGuid) {
        entries.push({ name: nameMatch[1].trim(), guid: currentGuid })
      }
    }

    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ name: 'My Home Network', guid: '{AABBCCDD-1122-3344-5566-778899AABBCC}' })
    expect(entries[1]).toEqual({ name: 'Office WiFi', guid: '{11223344-5566-7788-99AA-BBCCDDEEFF00}' })
  })

  it('handles empty registry output', () => {
    const entries: { name: string; guid: string }[] = []
    let currentGuid = ''
    for (const line of ''.split('\n')) {
      const guidMatch = line.match(/\\(\{[0-9A-F-]+\})$/i)
      if (guidMatch) currentGuid = guidMatch[1]
      const nameMatch = line.match(/ProfileName\s+REG_SZ\s+(.+)/i)
      if (nameMatch && currentGuid) entries.push({ name: nameMatch[1].trim(), guid: currentGuid })
    }
    expect(entries).toHaveLength(0)
  })
})
