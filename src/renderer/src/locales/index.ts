// Auto-import all locale JSON files using Vite's glob import.
// Each file is eagerly bundled at build time — no runtime file I/O.
const modules = import.meta.glob('./*/*.json', { eager: true }) as Record<
  string,
  { default: Record<string, unknown> }
>

// Build the resources object: { en: { common: {...}, sidebar: {...} }, es: { ... }, ... }
const resources: Record<string, Record<string, Record<string, unknown>>> = {}

for (const [path, mod] of Object.entries(modules)) {
  // path looks like "./en/common.json"
  const parts = path.split('/')
  const lang = parts[1]   // "en", "es", "fr", etc.
  const ns = parts[2].replace('.json', '') // "common", "sidebar", etc.
  if (!resources[lang]) resources[lang] = {}
  resources[lang][ns] = mod.default
}

export { resources }
export const namespaces = Object.keys(resources.en ?? {})
