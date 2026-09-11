import { describe, it, expect, vi } from 'vitest'

vi.mock('../platform', () => ({ getPlatform: () => ({}) }))
vi.mock('./threat-blacklist-store', () => ({ loadBlacklist: () => null }))
vi.mock('./logger', () => ({ logInfo: () => {}, logError: () => {} }))

import { ipv4ToNumber, ipv6ToBigInt, parseCidr, ipMatchesCidr } from './threat-monitor'

// ─── ipv4ToNumber ───────────────────────────────────────────

describe('ipv4ToNumber', () => {
  it('converts 0.0.0.0', () => {
    expect(ipv4ToNumber('0.0.0.0')).toBe(0)
  })

  it('converts 255.255.255.255', () => {
    expect(ipv4ToNumber('255.255.255.255')).toBe(0xffffffff)
  })

  it('converts 192.168.1.1', () => {
    expect(ipv4ToNumber('192.168.1.1')).toBe(((192 << 24) | (168 << 16) | (1 << 8) | 1) >>> 0)
  })

  it('converts 10.0.0.1', () => {
    expect(ipv4ToNumber('10.0.0.1')).toBe(((10 << 24) | 1) >>> 0)
  })

  it('returns null for invalid octet > 255', () => {
    expect(ipv4ToNumber('256.0.0.1')).toBeNull()
  })

  it('returns null for too few octets', () => {
    expect(ipv4ToNumber('192.168.1')).toBeNull()
  })

  it('returns null for too many octets', () => {
    expect(ipv4ToNumber('192.168.1.1.1')).toBeNull()
  })

  it('returns null for non-numeric', () => {
    expect(ipv4ToNumber('abc.def.ghi.jkl')).toBeNull()
  })

  it('returns null for negative octet', () => {
    expect(ipv4ToNumber('-1.0.0.0')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(ipv4ToNumber('')).toBeNull()
  })
})

// ─── ipv6ToBigInt ───────────────────────────────────────────

describe('ipv6ToBigInt', () => {
  it('converts full address', () => {
    expect(ipv6ToBigInt('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(
      0x20010db8000000000000000000000001n
    )
  })

  it('converts abbreviated with ::', () => {
    expect(ipv6ToBigInt('2001:db8::1')).toBe(0x20010db8000000000000000000000001n)
  })

  it('converts loopback ::1', () => {
    expect(ipv6ToBigInt('::1')).toBe(1n)
  })

  it('converts all-zeros ::', () => {
    expect(ipv6ToBigInt('::')).toBe(0n)
  })

  it('converts IPv4-mapped ::ffff:192.168.1.1', () => {
    const result = ipv6ToBigInt('::ffff:192.168.1.1')
    expect(result).not.toBeNull()
    // 0xffff00000000 | 192.168.1.1 as number
    const v4 = ((192 << 24) | (168 << 16) | (1 << 8) | 1) >>> 0
    expect(result).toBe(BigInt('0xffff00000000') | BigInt(v4))
  })

  it('returns null for triple colon', () => {
    expect(ipv6ToBigInt('2001:::1')).toBeNull()
  })

  it('returns null for too many groups', () => {
    expect(ipv6ToBigInt('1:2:3:4:5:6:7:8:9')).toBeNull()
  })

  it('returns null for invalid hex group', () => {
    expect(ipv6ToBigInt('gggg::1')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(ipv6ToBigInt('')).toBeNull()
  })
})

// ─── parseCidr ──────────────────────────────────────────────

describe('parseCidr', () => {
  it('parses IPv4 CIDR', () => {
    const result = parseCidr('10.0.0.0/8')
    expect(result).not.toBeNull()
    expect(result!.isV6).toBe(false)
    expect(result!.raw).toBe('10.0.0.0/8')
  })

  it('parses IPv6 CIDR', () => {
    const result = parseCidr('2001:db8::/32')
    expect(result).not.toBeNull()
    expect(result!.isV6).toBe(true)
  })

  it('returns null for missing slash', () => {
    expect(parseCidr('10.0.0.0')).toBeNull()
  })

  it('returns null for invalid prefix length (IPv4 > 32)', () => {
    expect(parseCidr('10.0.0.0/33')).toBeNull()
  })

  it('returns null for invalid prefix length (IPv6 > 128)', () => {
    expect(parseCidr('::1/129')).toBeNull()
  })

  it('returns null for negative prefix', () => {
    expect(parseCidr('10.0.0.0/-1')).toBeNull()
  })

  it('returns null for non-numeric prefix', () => {
    expect(parseCidr('10.0.0.0/abc')).toBeNull()
  })

  it('handles /0 prefix (match everything)', () => {
    const result = parseCidr('0.0.0.0/0')
    expect(result).not.toBeNull()
    expect(result!.mask).toBe(0)
  })

  it('handles /32 prefix (single host)', () => {
    const result = parseCidr('192.168.1.1/32')
    expect(result).not.toBeNull()
    expect(result!.mask).toBe(0xffffffff)
  })
})

// ─── ipMatchesCidr ──────────────────────────────────────────

describe('ipMatchesCidr', () => {
  it('matches IP within IPv4 /24 network', () => {
    const cidr = parseCidr('192.168.1.0/24')!
    expect(ipMatchesCidr('192.168.1.100', cidr)).toBe(true)
    expect(ipMatchesCidr('192.168.1.255', cidr)).toBe(true)
  })

  it('rejects IP outside IPv4 /24 network', () => {
    const cidr = parseCidr('192.168.1.0/24')!
    expect(ipMatchesCidr('192.168.2.1', cidr)).toBe(false)
    expect(ipMatchesCidr('10.0.0.1', cidr)).toBe(false)
  })

  it('matches IP within IPv4 /8 network', () => {
    const cidr = parseCidr('10.0.0.0/8')!
    expect(ipMatchesCidr('10.255.255.255', cidr)).toBe(true)
    expect(ipMatchesCidr('10.0.0.1', cidr)).toBe(true)
  })

  it('rejects IP outside IPv4 /8 network', () => {
    const cidr = parseCidr('10.0.0.0/8')!
    expect(ipMatchesCidr('11.0.0.1', cidr)).toBe(false)
  })

  it('matches single host /32', () => {
    const cidr = parseCidr('1.2.3.4/32')!
    expect(ipMatchesCidr('1.2.3.4', cidr)).toBe(true)
    expect(ipMatchesCidr('1.2.3.5', cidr)).toBe(false)
  })

  it('matches IPv6 within /64 network', () => {
    const cidr = parseCidr('2001:db8::/32')!
    expect(ipMatchesCidr('2001:db8::1', cidr)).toBe(true)
    expect(ipMatchesCidr('2001:db8:1::1', cidr)).toBe(true)
  })

  it('rejects IPv6 outside network', () => {
    const cidr = parseCidr('2001:db8::/32')!
    expect(ipMatchesCidr('2001:db9::1', cidr)).toBe(false)
  })

  it('returns false for invalid IP string', () => {
    const cidr = parseCidr('10.0.0.0/8')!
    expect(ipMatchesCidr('not-an-ip', cidr)).toBe(false)
  })

  it('returns false for IPv6 IP against IPv4 CIDR', () => {
    const cidr = parseCidr('10.0.0.0/8')!
    expect(ipMatchesCidr('::1', cidr)).toBe(false)
  })

  it('returns false for IPv4 IP against IPv6 CIDR', () => {
    const cidr = parseCidr('2001:db8::/32')!
    expect(ipMatchesCidr('10.0.0.1', cidr)).toBe(false)
  })
})
