import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { resources, namespaces } from './locales'

i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
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
