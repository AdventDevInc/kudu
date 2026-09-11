/**
 * Canonical list of shipped UI languages.
 *
 * Lives in `shared` because both sides need it for different reasons: the
 * renderer renders the picker from it, and the main process maps the OS
 * locale onto it when picking a fresh install's default language.
 */
export const LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română' },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar' }
] as const

export type LanguageCode = (typeof LANGUAGES)[number]['code']

export const RTL_LANGUAGES: readonly string[] = ['ar', 'he']

const CODES: readonly string[] = LANGUAGES.map((l) => l.code)

/**
 * Locale tags that don't reduce to one of our codes by taking the part before
 * the first dash. `nb`/`nn` are the two written forms of Norwegian, which we
 * ship as a single `no` bundle; the rest are legacy ISO-639 codes that some
 * platforms still report.
 */
const ALIASES: Record<string, string> = {
  nb: 'no',
  nn: 'no',
  iw: 'he', // pre-1989 Hebrew
  in: 'id' // pre-1989 Indonesian
}

/**
 * Map an OS locale tag (`app.getLocale()`, e.g. "ru-RU", "pt-BR", "zh-Hant-TW")
 * onto a shipped language code, falling back to English when nothing matches.
 */
export function matchLocaleToLanguage(locale: string | undefined | null): LanguageCode {
  if (!locale) return 'en'
  const tag = locale.trim()
  if (!tag) return 'en'

  // Exact match handles the two region-qualified codes we ship (zh-CN, zh-TW).
  const exact = CODES.find((c) => c.toLowerCase() === tag.toLowerCase())
  if (exact) return exact as LanguageCode

  const base = tag.split(/[-_]/)[0].toLowerCase()

  // Chinese carries the distinction in the script or region subtag rather than
  // the base, so it can't fall through to the generic lookup.
  if (base === 'zh') {
    return /(^|[-_])(hant|tw|hk|mo)([-_]|$)/i.test(tag) ? 'zh-TW' : 'zh-CN'
  }

  const aliased = ALIASES[base]
  if (aliased) return aliased as LanguageCode

  const match = CODES.find((c) => c.toLowerCase() === base)
  return (match ?? 'en') as LanguageCode
}
