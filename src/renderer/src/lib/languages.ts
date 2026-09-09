// The list itself lives in `shared` so the main process can reuse it when
// resolving a fresh install's default language from the OS locale.
export { LANGUAGES, RTL_LANGUAGES, matchLocaleToLanguage } from '@shared/languages'
export type { LanguageCode } from '@shared/languages'
