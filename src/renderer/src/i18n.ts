import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { resources, namespaces } from './locales'
import { matchLocaleToLanguage } from '@shared/languages'

// First paint happens before the settings round-trip below resolves, so seed
// the language from the browser locale (which Electron derives from the OS).
// A persisted choice still wins a moment later; this only avoids a flash of
// English for users whose system language we already ship.
const initialLanguage = matchLocaleToLanguage(
  typeof navigator !== 'undefined' ? navigator.language : 'en'
)

i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: 'en',
  ns: namespaces,
  defaultNS: 'common',
  interpolation: {
    escapeValue: false
  },
  react: {
    useSuspense: false
  }
})

// Sync language from persisted settings
window.kudu?.settingsGet?.().then((settings) => {
  if (settings?.language && settings.language !== i18n.language) {
    i18n.changeLanguage(settings.language)
  }
}).catch(() => {})

export default i18n
