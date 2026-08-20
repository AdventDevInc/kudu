#!/usr/bin/env node
// ─── Community Rules Catalog Generator ──────────────────────
// Auto-generates a markdown catalog from the JSON rule files.
// Run: npm run catalog

const { readFileSync, writeFileSync, existsSync } = require('fs')
const path = require('path')

const RULES_DIR = path.resolve(__dirname, '..', 'rules')
const OUTPUT_PATH = path.join(RULES_DIR, 'CATALOG.md')
const PLATFORMS = ['win32', 'darwin', 'linux']
const PLATFORM_LABELS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
const PLATFORM_EMOJI = { win32: '🪟', darwin: '🍎', linux: '🐧' }

function loadApps(platform, file) {
  const filePath = path.join(RULES_DIR, platform, file)
  if (!existsSync(filePath)) return []
  const data = JSON.parse(readFileSync(filePath, 'utf-8'))
  return data.apps || []
}

function loadSystemTargets(platform) {
  const filePath = path.join(RULES_DIR, platform, 'system.json')
  if (!existsSync(filePath)) return []
  const data = JSON.parse(readFileSync(filePath, 'utf-8'))
  return data.cleanTargets || []
}

function loadDatabaseTargets(platform) {
  const filePath = path.join(RULES_DIR, platform, 'databases.json')
  if (!existsSync(filePath)) return []
  const data = JSON.parse(readFileSync(filePath, 'utf-8'))
  return data.targets || []
}

function loadBrowsers(platform) {
  const filePath = path.join(RULES_DIR, platform, 'browsers.json')
  if (!existsSync(filePath)) return { chromium: [], hasFirefox: false, hasSafari: false }
  const data = JSON.parse(readFileSync(filePath, 'utf-8'))
  return {
    chromium: (data.chromium || []).map((b) => b.key),
    hasFirefox: !!data.firefox,
    hasSafari: !!data.safari,
  }
}

function main() {
  const lines = []
  const w = (line) => lines.push(line === undefined ? '' : line)

  w('# Kudu Cleaner Rules Catalog')
  w()
  w('> Auto-generated from the JSON rule files. Do not edit manually.')
  w('>')
  w('> To regenerate: `npm run catalog`')
  w()

  // ─── Summary table ─────────────────────────────────────────

  w('## Summary')
  w()

  const appCounts = {}
  const allAppIds = new Set()
  for (const p of PLATFORMS) {
    const apps = [].concat(loadApps(p, 'apps.json'), loadApps(p, 'gaming.json'), loadApps(p, 'gpu-cache.json'))
    appCounts[p] = apps.length
    apps.forEach((a) => allAppIds.add(a.id))
  }

  w('| Metric | Count |')
  w('|--------|-------|')
  w(`| Unique app rules | ${allAppIds.size} |`)
  for (const p of PLATFORMS) {
    w(`| ${PLATFORM_EMOJI[p]} ${PLATFORM_LABELS[p]} rules | ${appCounts[p]} |`)
  }
  w()

  // ─── Apps ──────────────────────────────────────────────────

  const categories = [
    { title: 'AI Tools', file: 'apps.json', group: 'AI Tools' },
    { title: 'Applications', file: 'apps.json', excludeGrouped: true },
    { title: 'Gaming & Launchers', file: 'gaming.json' },
    { title: 'GPU Cache', file: 'gpu-cache.json' },
  ]

  for (const { title, file, group, excludeGrouped } of categories) {
    w(`## ${title}`)
    w()

    const allIds = new Map()
    for (const p of PLATFORMS) {
      for (const app of loadApps(p, file)) {
        if (group && app.group !== group) continue
        if (excludeGrouped && app.group) continue
        if (!allIds.has(app.id)) {
          allIds.set(app.id, { name: app.name, platforms: new Set() })
        }
        allIds.get(app.id).platforms.add(p)
      }
    }

    if (allIds.size === 0) {
      w('_No rules in this category._')
      w()
      continue
    }

    const sorted = Array.from(allIds.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name))

    w('| App | ' + PLATFORMS.map((p) => PLATFORM_EMOJI[p]).join(' | ') + ' |')
    w('|-----|' + PLATFORMS.map(() => ':---:').join('|') + '|')

    for (const [, { name, platforms }] of sorted) {
      const cols = PLATFORMS.map((p) => platforms.has(p) ? '✅' : '❌')
      w(`| ${name} | ${cols.join(' | ')} |`)
    }
    w()
  }

  // ─── Browsers ──────────────────────────────────────────────

  w('## Browsers')
  w()

  const browserNames = {
    chrome: 'Google Chrome', edge: 'Microsoft Edge', brave: 'Brave',
    opera: 'Opera', operaGX: 'Opera GX', vivaldi: 'Vivaldi',
    arc: 'Arc', chromium: 'Chromium', firefox: 'Firefox', safari: 'Safari',
  }

  const allBrowsers = new Set()
  const browserPlatforms = {}
  for (const p of PLATFORMS) {
    const b = loadBrowsers(p)
    for (const key of b.chromium) {
      allBrowsers.add(key)
      browserPlatforms[key] = browserPlatforms[key] || new Set()
      browserPlatforms[key].add(p)
    }
    if (b.hasFirefox) {
      allBrowsers.add('firefox')
      browserPlatforms['firefox'] = browserPlatforms['firefox'] || new Set()
      browserPlatforms['firefox'].add(p)
    }
    if (b.hasSafari) {
      allBrowsers.add('safari')
      browserPlatforms['safari'] = browserPlatforms['safari'] || new Set()
      browserPlatforms['safari'].add(p)
    }
  }

  w('| Browser | ' + PLATFORMS.map((p) => PLATFORM_EMOJI[p]).join(' | ') + ' |')
  w('|---------|' + PLATFORMS.map(() => ':---:').join('|') + '|')

  for (const key of Array.from(allBrowsers).sort()) {
    const name = browserNames[key] || key
    const cols = PLATFORMS.map((p) => (browserPlatforms[key] && browserPlatforms[key].has(p) ? '✅' : '❌'))
    w(`| ${name} | ${cols.join(' | ')} |`)
  }
  w()

  // ─── Database Optimization ────────────────────────────────

  w('## Database Optimization Targets')
  w()

  const allDbLabels = new Map()
  for (const p of PLATFORMS) {
    for (const t of loadDatabaseTargets(p)) {
      if (!allDbLabels.has(t.label)) {
        allDbLabels.set(t.label, new Set())
      }
      allDbLabels.get(t.label).add(p)
    }
  }

  w('| Target | ' + PLATFORMS.map((p) => PLATFORM_EMOJI[p]).join(' | ') + ' |')
  w('|--------|' + PLATFORMS.map(() => ':---:').join('|') + '|')

  for (const [label, platforms] of Array.from(allDbLabels.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const cols = PLATFORMS.map((p) => platforms.has(p) ? '✅' : '❌')
    w(`| ${label} | ${cols.join(' | ')} |`)
  }
  w()

  // ─── System Targets ────────────────────────────────────────

  w('## System Clean Targets')
  w()

  for (const p of PLATFORMS) {
    const targets = loadSystemTargets(p)
    if (targets.length === 0) continue

    w(`### ${PLATFORM_EMOJI[p]} ${PLATFORM_LABELS[p]}`)
    w()

    const subcats = Array.from(new Set(targets.map((t) => t.subcategory))).sort()
    for (const sub of subcats) {
      const adminTargets = targets.filter((t) => t.subcategory === sub && t.needsAdmin)
      const adminNote = adminTargets.length > 0 ? ' 🔒' : ''
      w(`- ${sub}${adminNote}`)
    }
    w()
  }

  // ─── Contributing ──────────────────────────────────────────

  w('## Contributing')
  w()
  w('Want to add a missing app? See the [Rules Contributing Guide](RULES.md) or run:')
  w()
  w('```bash')
  w('npm run new-rule       # Interactive rule generator')
  w('npm run find-cache     # Discover uncovered cache directories')
  w('npm run preview-rule   # Preview what a rule would clean')
  w('npm run parity-check   # See cross-platform coverage gaps')
  w('```')
  w()

  writeFileSync(OUTPUT_PATH, lines.join('\n'))
  console.log(`✓ Catalog written to ${path.relative(process.cwd(), OUTPUT_PATH)}`)
  console.log(`  ${allAppIds.size} unique app rules across ${PLATFORMS.length} platforms`)
}

main()
