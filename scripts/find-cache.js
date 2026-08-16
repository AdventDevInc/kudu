#!/usr/bin/env node
// ─── Path Discovery Helper ──────────────────────────────────
// Scans common cache directories on the current OS and reports
// apps with cache dirs that Kudu doesn't already cover.
// Run: npm run find-cache

const { readdirSync, statSync, readFileSync, existsSync } = require('fs')
const { homedir, tmpdir, platform } = require('os')
const path = require('path')

const RULES_DIR = path.resolve(__dirname, '..', 'rules')
const currentPlatform = platform()

// ─── Load all known paths for this platform ─────────────────

function loadKnownPaths() {
  const known = new Set()
  const platformDir = path.join(RULES_DIR, currentPlatform)

  if (!existsSync(platformDir)) {
    console.error(`No rules directory for platform "${currentPlatform}"`)
    process.exit(1)
  }

  const vars = resolveVars()
  const files = readdirSync(platformDir).filter((f) => f.endsWith('.json'))

  const addRulePaths = (rule) => {
    const templates = rule.paths || (rule.path ? [rule.path] : [])
    for (const template of templates) {
      const resolved = path.normalize(template.replace(/\$\{([A-Z_]+)\}/g, (_, name) => vars[name] || ''))
      if (!resolved) continue

      // These rules make only their resolved children cleanable. Treating the
      // broad base itself as covered would hide every other cache below it.
      if (rule.recursiveMatch) continue
      if (rule.childSubdir) {
        for (const child of getDirsIn(resolved)) {
          const target = path.join(child.full, rule.childSubdir)
          if (existsSync(target)) known.add(path.normalize(target).toLowerCase())
        }
        continue
      }

      known.add(resolved.toLowerCase())
    }
  }

  for (const file of files) {
    const data = JSON.parse(readFileSync(path.join(platformDir, file), 'utf-8'))
    for (const rule of data.apps || []) addRulePaths(rule)
    for (const rule of data.cleanTargets || []) addRulePaths(rule)
  }

  return known
}

function resolveVars() {
  const home = homedir()
  const tmp = tmpdir()

  if (currentPlatform === 'win32') {
    return {
      HOME: home,
      LOCALAPPDATA: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
      APPDATA: process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
      WINDIR: process.env.WINDIR || 'C:\\Windows',
      PROGRAMDATA: process.env.ProgramData || 'C:\\ProgramData',
      PROGRAMFILES: process.env.ProgramFiles || 'C:\\Program Files',
      PROGRAMFILES_X86: process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      TMPDIR: tmp,
    }
  }
  if (currentPlatform === 'darwin') {
    return {
      HOME: home,
      LIBRARY: path.join(home, 'Library'),
      CACHES: path.join(home, 'Library', 'Caches'),
      APP_SUPPORT: path.join(home, 'Library', 'Application Support'),
      TMPDIR: tmp,
    }
  }
  // linux
  return {
    HOME: home,
    CONFIG: process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    CACHE: process.env.XDG_CACHE_HOME || path.join(home, '.cache'),
    LOCAL_SHARE: process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
    TMPDIR: tmp,
  }
}

// ─── Scan directories for potential cache locations ─────────

function getDirsIn(dir) {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .map((name) => ({ name, full: path.join(dir, name) }))
      .filter(({ full }) => {
        try { return statSync(full).isDirectory() } catch { return false }
      })
  } catch { return [] }
}

function hasCacheIndicators(dirPath) {
  const indicators = ['Cache', 'cache', 'Cache_Data', 'CachedData', 'GPUCache', 'Code Cache', 'logs', 'tmp', 'temp']
  try {
    const children = readdirSync(dirPath)
    return children.filter((c) => indicators.includes(c))
  } catch {
    return []
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function getDirSize(dir) {
  let total = 0
  try {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      try {
        const stat = statSync(full)
        if (stat.isFile()) total += stat.size
        else if (stat.isDirectory()) total += getDirSize(full)
      } catch { /* skip inaccessible */ }
    }
  } catch { /* skip */ }
  return total
}

function main() {
  console.log(`\n🔍 Kudu — Cache Path Discovery (${currentPlatform})\n`)
  console.log('Scanning for uncovered cache directories...\n')

  const knownPaths = loadKnownPaths()
  const vars = resolveVars()

  // Directories to scan for app data
  const scanDirs = []
  if (currentPlatform === 'win32') {
    scanDirs.push(
      { dir: vars.APPDATA, varName: '${APPDATA}' },
      { dir: vars.LOCALAPPDATA, varName: '${LOCALAPPDATA}' },
    )
  } else if (currentPlatform === 'darwin') {
    scanDirs.push(
      { dir: vars.CACHES, varName: '${CACHES}' },
      { dir: vars.APP_SUPPORT, varName: '${APP_SUPPORT}' },
    )
  } else {
    scanDirs.push(
      { dir: vars.CACHE, varName: '${CACHE}' },
      { dir: vars.CONFIG, varName: '${CONFIG}' },
    )
  }

  const discoveries = []

  for (const { dir, varName } of scanDirs) {
    const appDirs = getDirsIn(dir)

    for (const { name, full } of appDirs) {
      const cacheChildren = hasCacheIndicators(full)
      if (cacheChildren.length === 0) continue

      const uncoveredCaches = cacheChildren.filter((child) => {
        const fullPath = path.normalize(path.join(full, child)).toLowerCase()
        for (const known of knownPaths) {
          if (fullPath.startsWith(known) || known.startsWith(fullPath)) return false
        }
        return true
      })

      if (uncoveredCaches.length === 0) continue

      const cachePaths = uncoveredCaches.map((child) => ({
        template: `${varName}/${name}/${child}`,
        full: path.join(full, child),
        size: getDirSize(path.join(full, child)),
      }))

      const totalSize = cachePaths.reduce((sum, p) => sum + p.size, 0)
      if (totalSize < 1024) continue // skip tiny dirs

      discoveries.push({ name, cachePaths, totalSize })
    }
  }

  // Sort by size descending
  discoveries.sort((a, b) => b.totalSize - a.totalSize)

  if (discoveries.length === 0) {
    console.log('✓ No uncovered cache directories found — great coverage!')
    return
  }

  console.log(`Found ${discoveries.length} uncovered app(s) with cache directories:\n`)

  for (const { name, cachePaths, totalSize } of discoveries) {
    console.log(`  ${name}  (${formatSize(totalSize)})`)
    for (const { template, size } of cachePaths) {
      console.log(`    ${template}  (${formatSize(size)})`)
    }
    console.log()
  }

  console.log('─'.repeat(60))
  console.log('To add a rule for any of these, run: npm run new-rule')
  console.log('Or manually edit the JSON files in rules/' + currentPlatform + '/')
}

main()
