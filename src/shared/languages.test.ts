import { describe, it, expect } from 'vitest'
import { LANGUAGES, matchLocaleToLanguage } from './languages'

describe('matchLocaleToLanguage', () => {
  it('matches a region-qualified locale to its base language', () => {
    expect(matchLocaleToLanguage('ru-RU')).toBe('ru')
    expect(matchLocaleToLanguage('pt-BR')).toBe('pt')
    expect(matchLocaleToLanguage('de-AT')).toBe('de')
  })

  it('matches a bare language tag', () => {
    expect(matchLocaleToLanguage('ru')).toBe('ru')
    expect(matchLocaleToLanguage('ja')).toBe('ja')
  })

  it('is case- and separator-insensitive', () => {
    expect(matchLocaleToLanguage('RU-ru')).toBe('ru')
    expect(matchLocaleToLanguage('ru_RU')).toBe('ru')
  })

  it('keeps Simplified and Traditional Chinese apart', () => {
    expect(matchLocaleToLanguage('zh-CN')).toBe('zh-CN')
    expect(matchLocaleToLanguage('zh-Hans-CN')).toBe('zh-CN')
    expect(matchLocaleToLanguage('zh-TW')).toBe('zh-TW')
    expect(matchLocaleToLanguage('zh-Hant-HK')).toBe('zh-TW')
    // Bare "zh" carries no script hint — Simplified is the larger audience.
    expect(matchLocaleToLanguage('zh')).toBe('zh-CN')
  })

  it('folds both written forms of Norwegian onto the single "no" bundle', () => {
    expect(matchLocaleToLanguage('nb-NO')).toBe('no')
    expect(matchLocaleToLanguage('nn-NO')).toBe('no')
    expect(matchLocaleToLanguage('no')).toBe('no')
  })

  it('accepts legacy ISO-639 codes some platforms still report', () => {
    expect(matchLocaleToLanguage('iw-IL')).toBe('he')
    expect(matchLocaleToLanguage('in-ID')).toBe('id')
  })

  it('falls back to English for anything unshipped or absent', () => {
    expect(matchLocaleToLanguage('is-IS')).toBe('en')
    expect(matchLocaleToLanguage('')).toBe('en')
    expect(matchLocaleToLanguage('   ')).toBe('en')
    expect(matchLocaleToLanguage(undefined)).toBe('en')
    expect(matchLocaleToLanguage(null)).toBe('en')
  })

  it('resolves every shipped code back to itself', () => {
    for (const { code } of LANGUAGES) {
      expect(matchLocaleToLanguage(code)).toBe(code)
    }
  })
})
