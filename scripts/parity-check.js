#!/usr/bin/env node
// ─── Cross-Platform Parity Checker ──────────────────────────
// Reports which app IDs exist on some platforms but not others,
// helping contributors find coverage gaps.
// Run: npm run parity-check

const { readFileSync, existsSync } = require('fs')
const path = require('path')

const RULES_DIR = path.resolve(__dirname, '..', 'rules')
const PLATFORMS = ['win32', 'darwin', 'linux']
const APP_FILES = ['apps.json', 'gaming.json', 'gpu-cache.json']

function loadAppIds(platform) {
  const ids = new Map() // id → { name, source }
  for (const file of APP_FILES) {
    const filePath = path.join(RULES_DIR, platform, file)
    if (!existsSync(filePath)) continue
    const data = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (data.apps) {
      for (const app of data.apps) {
        ids.set(app.id, { name: app.name, source: file })
      }
    }
  }
  return ids
}

function main() {
  console.log('\n📊 Kudu — Cross-Platform Parity Report\n')

  const platformApps = {}
  for (const p of PLATFORMS) {
    platformApps[p] = loadAppIds(p)
  }

  const allIds = new Set()
  for (const p of PLATFORMS) {
    for (const id of platformApps[p].keys()) {
      allIds.add(id)
    }
  }

  const sortedIds = [...allIds].sort()

  const full = []
  const partial = []
  const single = []

  for (const id of sortedIds) {
    const present = PLATFORMS.filter((p) => platformApps[p].has(id))
    const missing = PLATFORMS.filter((p) => !platformApps[p].has(id))
    const info = platformApps[present[0]].get(id)

    if (present.length === 3) {
      full.push({ id, name: info.name })
    } else if (present.length === 2) {
      partial.push({ id, name: info.name, present, missing })
    } else {
      single.push({ id, name: info.name, present, missing })
    }
  }

  console.log(`  Total unique rules: ${sortedIds.length}`)
  console.log(`  ✅ All platforms:   ${full.length}`)
  console.log(`  ⚠️  Partial:        ${partial.length}`)
  console.log(`  ❌ Single platform: ${single.length}`)

  if (partial.length === 0 && single.length === 0) {
    console.log('\n  All rules have full cross-platform coverage! 🎉\n')
    return
  }

  console.log('\n── Coverage Gaps ──\n')

  const nameWidth = Math.max(20, ...[...partial, ...single].map((x) => x.name.length))

  console.log(
    '  ' +
      'ID'.padEnd(25) +
      'Name'.padEnd(nameWidth + 2) +
      'win32'.padEnd(8) +
      'darwin'.padEnd(8) +
      'linux'.padEnd(8)
  )
  console.log('  ' + '─'.repeat(25 + nameWidth + 2 + 24))

  for (const { id, name, present } of [...partial, ...single]) {
    const cols = PLATFORMS.map((p) => (present.includes(p) ? '  ✅' : '  ❌'))
    console.log(
      '  ' +
        id.padEnd(25) +
        name.padEnd(nameWidth + 2) +
        cols[0].padEnd(8) +
        cols[1].padEnd(8) +
        cols[2].padEnd(8)
    )
  }

  console.log('\n── Missing Rules (good first issues!) ──\n')

  for (const { id, name, present, missing } of [...partial, ...single]) {
    console.log(`  ${name} (${id})`)
    console.log(`    Present: ${present.join(', ')}`)
    console.log(`    Missing: ${missing.join(', ')}`)
    console.log()
  }

  console.log('── Per-Platform Counts ──\n')
  for (const p of PLATFORMS) {
    console.log(`  ${p}: ${platformApps[p].size} rules`)
  }
  console.log()
}

main()
