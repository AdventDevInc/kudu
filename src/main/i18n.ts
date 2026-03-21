import { getSettings } from './services/settings-store'

import en from '../renderer/src/locales/en/tray.json'
import ar from '../renderer/src/locales/ar/tray.json'
import cs from '../renderer/src/locales/cs/tray.json'
import da from '../renderer/src/locales/da/tray.json'
import de from '../renderer/src/locales/de/tray.json'
import el from '../renderer/src/locales/el/tray.json'
import es from '../renderer/src/locales/es/tray.json'
import fi from '../renderer/src/locales/fi/tray.json'
import fr from '../renderer/src/locales/fr/tray.json'
import he from '../renderer/src/locales/he/tray.json'
import hi from '../renderer/src/locales/hi/tray.json'
import hu from '../renderer/src/locales/hu/tray.json'
import id from '../renderer/src/locales/id/tray.json'
import it from '../renderer/src/locales/it/tray.json'
import ja from '../renderer/src/locales/ja/tray.json'
import ko from '../renderer/src/locales/ko/tray.json'
import ms from '../renderer/src/locales/ms/tray.json'
import nl from '../renderer/src/locales/nl/tray.json'
import no from '../renderer/src/locales/no/tray.json'
import pl from '../renderer/src/locales/pl/tray.json'
import pt from '../renderer/src/locales/pt/tray.json'
import ro from '../renderer/src/locales/ro/tray.json'
import ru from '../renderer/src/locales/ru/tray.json'
import sv from '../renderer/src/locales/sv/tray.json'
import th from '../renderer/src/locales/th/tray.json'
import tr from '../renderer/src/locales/tr/tray.json'
import uk from '../renderer/src/locales/uk/tray.json'
import vi from '../renderer/src/locales/vi/tray.json'
import zhCN from '../renderer/src/locales/zh-CN/tray.json'
import zhTW from '../renderer/src/locales/zh-TW/tray.json'

const resources: Record<string, Record<string, string>> = {
  en, ar, cs, da, de, el, es, fi, fr, he, hi, hu, id, it, ja, ko,
  ms, nl, no, pl, pt, ro, ru, sv, th, tr, uk, vi,
  'zh-CN': zhCN,
  'zh-TW': zhTW
}

export function t(key: string, params?: Record<string, string | number>): string {
  let lang: string
  try {
    lang = getSettings().language || 'en'
  } catch {
    lang = 'en'
  }
  const str = resources[lang]?.[key] ?? resources.en[key] ?? key
  if (!params) return str
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => String(params[k] ?? ''))
}
