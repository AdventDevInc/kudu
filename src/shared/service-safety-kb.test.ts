import { describe, it, expect } from 'vitest'
import { lookupServiceSafety, SERVICE_SAFETY_KB } from './service-safety-kb'

describe('lookupServiceSafety', () => {
  it('finds a known safe service', () => {
    const result = lookupServiceSafety('DiagTrack')
    expect(result.safety).toBe('safe')
    expect(result.category).toBe('telemetry')
  })

  it('is case-insensitive', () => {
    expect(lookupServiceSafety('DIAGTRACK').safety).toBe('safe')
    expect(lookupServiceSafety('diagtrack').safety).toBe('safe')
  })

  it('finds an unsafe service', () => {
    const result = lookupServiceSafety('WinDefend')
    expect(result.safety).toBe('unsafe')
    expect(result.category).toBe('security')
  })

  it('finds a caution service', () => {
    const result = lookupServiceSafety('Spooler')
    expect(result.safety).toBe('caution')
    expect(result.category).toBe('print')
  })

  it('does not recommend disabling Phone Service used by wireless headset dongles', () => {
    const result = lookupServiceSafety('PhoneSvc')
    expect(result.safety).toBe('caution')
    expect(result.note).toContain('Audeze Maxwell')
  })

  it('strips per-user suffix before lookup', () => {
    // CDPUserSvc_abc12 → CDPUserSvc
    const result = lookupServiceSafety('CDPUserSvc_1a2b3c')
    expect(result.safety).toBe('caution')
    expect(result.category).toBe('telemetry')
  })

  it('strips per-user suffix for other services', () => {
    const result = lookupServiceSafety('WpnUserService_abcdef')
    expect(result.safety).toBe('caution')
    expect(result.category).toBe('misc')
  })

  it('returns caution/unknown for unrecognized service', () => {
    const result = lookupServiceSafety('SomeRandomService')
    expect(result.safety).toBe('caution')
    expect(result.category).toBe('unknown')
    expect(result.note).toBe('')
  })

  it('knowledge base has entries for all safety levels', () => {
    const entries = Object.values(SERVICE_SAFETY_KB)
    expect(entries.some((e) => e.safety === 'safe')).toBe(true)
    expect(entries.some((e) => e.safety === 'caution')).toBe(true)
    expect(entries.some((e) => e.safety === 'unsafe')).toBe(true)
  })

  it('all KB entries have non-empty notes', () => {
    for (const [key, entry] of Object.entries(SERVICE_SAFETY_KB)) {
      expect(entry.note, `${key} should have a note`).toBeTruthy()
    }
  })
})
