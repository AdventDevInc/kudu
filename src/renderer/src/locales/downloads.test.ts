import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createRequire } from 'module'
import { runInNewContext } from 'vm'
import i18next from 'i18next'
import { describe, expect, it } from 'vitest'
import { LANGUAGES } from '../../../shared/languages'

const families = ['reviewCount', 'selected', 'confirmTitle', 'outcome', 'skipped']
const counts = [0, 1, 2, 3, 5, 11, 21, 100, 1000000, 1.5]
const localePath = resolve('src/renderer/src/locales')
const readLocale = (code: string): Record<string, string> =>
  JSON.parse(readFileSync(resolve(localePath, code, 'downloads.json'), 'utf8'))

describe('Downloads localized file counts', () => {
  for (const { code } of LANGUAGES) {
    it(`resolves ${code} plural forms locally for every supported count family`, async () => {
      const translations = readLocale(code)
      const instance = i18next.createInstance()
      await instance.init({
        lng: code,
        fallbackLng: 'en',
        defaultNS: 'downloads',
        resources: {
          [code]: { downloads: translations },
          ...(code === 'en' ? {} : { en: { downloads: readLocale('en') } })
        }
      })
      const plurals = new Intl.PluralRules(code)
      for (const family of families) {
        for (const category of plurals.resolvedOptions().pluralCategories) {
          expect(translations[`${family}_${category}`], `${code}: ${family}_${category}`)
            .toContain('{{count}}')
        }
        for (const count of counts) {
          const suffix = count === 0 ? 'zero' : plurals.select(count)
          const key = `${family}_${suffix}`
          const resolved = instance.t(family, { count, returnDetails: true })
          expect(resolved.usedLng).toBe(code)
          expect(resolved.exactUsedKey).toBe(key)
          expect(resolved.res).toBe(translations[key].replaceAll('{{count}}', String(count)))
        }
      }
    })
  }

  it('retains the localized plural forms through the translation structural sync', () => {
    const scriptPath = resolve('scripts/translate.js')
    const source = readFileSync(scriptPath, 'utf8')
    // Load the real merge helper without starting the translation CLI or calling the API.
    const merge = runInNewContext(
      source.slice(0, source.lastIndexOf('\nmain().catch')) + '\nmergeTranslation',
      { require: createRequire(import.meta.url), __dirname: resolve('scripts'), process }
    ) as (source: object, existing: object, fresh: object, keys: Set<string>) => Record<string, string>
    const english = readLocale('en')
    for (const { code } of LANGUAGES) {
      const translations = readLocale(code)
      const synced = merge(english, translations, {}, new Set())
      for (const family of families) {
        for (const suffix of ['zero', 'one', 'two', 'few', 'many', 'other']) {
          const key = `${family}_${suffix}`
          expect(synced[key], `${code}: ${key}`).toBe(translations[key])
        }
      }
    }
  })

  it('uses the distinct Czech, Polish, Russian, Ukrainian, Romanian and Arabic forms', () => {
    expect(readLocale('cs').reviewCount_few).toBe('{{count}} soubory ke kontrole')
    expect(readLocale('cs').confirmTitle_other).toBe('Přesunout {{count}} souborů do koše?')
    expect(readLocale('pl').selected_few).toBe('Zaznaczono {{count}} pliki')
    expect(readLocale('ru').reviewCount_few).toBe('{{count}} файла для проверки')
    expect(readLocale('uk').reviewCount_few).toBe('{{count}} файли для перевірки')
    expect(readLocale('ro').reviewCount_few).toBe('{{count}} fișiere de revizuit')
    expect(readLocale('ro').reviewCount_other).toBe('{{count}} de fișiere de revizuit')
    expect(readLocale('ar').reviewCount_two).toBe('ملفان للمراجعة ({{count}})')
    expect(readLocale('ar').reviewCount_few).toBe('{{count}} ملفات للمراجعة')
    expect(readLocale('ar').reviewCount_many).toBe('{{count}} ملفًا للمراجعة')
  })
})
