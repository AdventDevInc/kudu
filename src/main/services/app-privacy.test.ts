import { describe, expect, it, vi, afterEach } from 'vitest'
import { parseAppPrivacyReport, parsePrivacyFiletime, scanAppPrivacy } from './app-privacy'
import { appPrivacyLastUse } from '../../shared/app-privacy'

const now = Date.UTC(2026, 9, 10)
const filetime = (milliseconds: number) =>
  ((BigInt(milliseconds) + 11644473600000n) * 10000n).toString()
const raw = (records: unknown[] = []) => ({
  account: 'PC\\Alex',
  capabilities: [{ capability: 'webcam', status: 'available', userConsent: 'Allow' }],
  records
})
const row = (overrides = {}) => ({
  capability: 'webcam',
  kind: 'desktop',
  identity: 'C:#Apps#camera.exe',
  start: filetime(now - 10000),
  end: filetime(now - 5000),
  consent: 'Allow',
  ...overrides
})

afterEach(() => vi.restoreAllMocks())

describe('app privacy records', () => {
  it('uses the recorded end for recent-use filtering of sessions that began before the window', () => {
    const record = parseAppPrivacyReport(
      raw([row({ start: filetime(now - 31 * 86400000), end: filetime(now - 1000) })]),
      now
    ).records[0]
    expect(appPrivacyLastUse(record)).toBe(new Date(now - 1000).toISOString())
    expect(Date.parse(appPrivacyLastUse(record)!)).toBeGreaterThan(now - 30 * 86400000)
    expect(appPrivacyLastUse({ ...record, lastEnd: null })).toBe(record.lastAccess)
    expect(appPrivacyLastUse({ ...record, lastAccess: null, lastEnd: null })).toBeNull()
  })
  it('preserves FILETIME precision and rejects zero, malformed, numeric, negative, pre-epoch and future times', () => {
    expect(parsePrivacyFiletime(filetime(now - 1), now)).toBe(new Date(now - 1).toISOString())
    for (const value of [
      '0',
      '',
      '-1',
      'NaN',
      '123',
      '9'.repeat(21),
      filetime(now + 1),
      Number(filetime(now)),
      null
    ]) {
      expect(parsePrivacyFiletime(value, now)).toBeNull()
    }
  })
  it('decodes desktop identity, but does not claim installed status or publisher trust', () => {
    const report = parseAppPrivacyReport(raw([row()]), now)
    expect(report.account).toBe('PC\\Alex')
    expect(report.records[0]).toMatchObject({
      name: 'camera.exe',
      identity: 'C:\\Apps\\camera.exe',
      kind: 'desktop',
      consent: 'allow',
      usage: 'recorded'
    })
    expect(report.capabilities[0]).toMatchObject({ userConsent: 'allow', deviceConsent: 'unknown' })
    expect(report.capabilities[1].status).toBe('unavailable')
  })
  it('treats a valid start with zero stop as unfinished history, never live usage', () => {
    expect(parseAppPrivacyReport(raw([row({ end: '0' })]), now).records[0]).toMatchObject({
      usage: 'unfinished',
      lastEnd: null
    })
    for (const overrides of [
      { end: '' },
      { end: 'bad' },
      { start: filetime(now + 1), end: '0' },
      { end: filetime(now - 20000) }
    ]) {
      expect(parseAppPrivacyReport(raw([row(overrides)]), now).records[0].usage).toBe('unknown')
    }
  })
  it('deduplicates case variants per capability and retains newest usage without inventing consent', () => {
    const records = parseAppPrivacyReport(
      raw([
        row({ start: filetime(now - 20000) }),
        row({ identity: 'c:#apps#CAMERA.exe', consent: 'Deny' }),
        row({ capability: 'microphone' })
      ]),
      now
    ).records
    expect(records).toHaveLength(2)
    expect(records.find((entry) => entry.capability === 'webcam')).toMatchObject({
      lastAccess: new Date(now - 10000).toISOString(),
      consent: 'unknown'
    })
  })
  it('keeps package identities and distinct executable paths separate', () => {
    const records = parseAppPrivacyReport(
      raw([
        row(),
        row({ identity: 'D:#Apps#camera.exe' }),
        row({ kind: 'packaged', identity: 'Microsoft.WindowsCamera_8wekyb3d8bbwe' })
      ]),
      now
    ).records
    expect(records).toHaveLength(3)
    expect(records.find((entry) => entry.kind === 'packaged')?.name).toBe('Microsoft.WindowsCamera')
  })
  it('retains explicit partial/missing/unavailable status and scan limit information', () => {
    const report = parseAppPrivacyReport(
      {
        ...raw(),
        capabilities: [
          { capability: 'webcam', status: 'partial', truncated: true, desktopConsent: 'Prompt' },
          { capability: 'microphone', status: 'missing' },
          { capability: 'location', status: 'unavailable' }
        ]
      },
      now
    )
    expect(report.capabilities.map((entry) => entry.status)).toEqual([
      'partial',
      'missing',
      'unavailable'
    ])
    expect(report.capabilities[0]).toMatchObject({ truncated: true, desktopConsent: 'prompt' })
  })
  it('rejects broken response envelopes and discards malformed entries', () => {
    expect(() => parseAppPrivacyReport({})).toThrow('Invalid app privacy scan response')
    expect(
      parseAppPrivacyReport(
        raw([
          null,
          row({ capability: 'contacts' }),
          row({ identity: '' }),
          row({ kind: 'bogus' }),
          row({ identity: 1 })
        ]),
        now
      ).records
    ).toEqual([])
  })
  it('returns an unsupported result without spawning a Windows command on other platforms', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(await scanAppPrivacy()).toMatchObject({ supported: false, records: [] })
  })
})
