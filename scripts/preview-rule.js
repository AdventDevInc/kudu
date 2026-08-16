#!/usr/bin/env node
// ─── Rule Playground / Dry-Run Mode ─────────────────────────
// Shows what directories a rule would scan/clean on the current
// machine, with sizes and file counts. Nothing is deleted.
// Run: npm run preview-rule -- <app-id>
// Run: npm run preview-rule            (lists all available IDs)

const { readFileSync, readdirSync, statSync, lstatSync, existsSync } = require('fs')
const { homedir, tmpdir, platform } = require('os')
const path = require('path')

const RULES_DIR = path.resolve(__dirname, '..', 'rules')
const currentPlatform = platform()

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
  return {
    HOME: home,
    CONFIG: process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    CACHE: process.env.XDG_CACHE_HOME || path.join(home, '.cache'),
    LOCAL_SHARE: process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
    TMPDIR: tmp,
  }
}

function resolvePath(templatePath, vars) {
  return path.normalize(
    templatePath.replace(/\$\{([A-Z_]+)\}/g, (_, name) => vars[name] || `\${${name}}`)
  )
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function getDirStats(dir, minAgeDays) {
  let totalSize = 0
  let fileCount = 0
  const cutoff = minAgeDays ? Date.now() - minAgeDays * 24 * 60 * 60 * 1000 : Infinity

  function walk(d) {
    try {
      for (const entry of readdirSync(d)) {
        const full = path.join(d, entry)
        try {
          const stat = statSync(full)
          if (stat.isFile()) {
            if (stat.mtimeMs > cutoff) continue
            totalSize += stat.size
            fileCount++
          } else if (stat.isDirectory()) {
            walk(full)
          }
        } catch { /* skip inaccessible */ }
      }
    } catch { /* skip */ }
  }

  walk(dir)
  return { totalSize, fileCount }
}

function expandFileMatches(basePath, match) {
  const normalize = currentPlatform === 'win32' ? (name) => name.toLowerCase() : (name) => name
  const names = new Set(match.names.map(normalize))
  const blockers = new Set((match.skipIfChildExists || []).map(normalize))
  const suffix = match.childDirSuffix ? normalize(match.childDirSuffix) : null
  const cutoff = Date.now() - match.minAgeDays * 24 * 60 * 60 * 1000
  let candidateDirs = [basePath]

  if (suffix) {
    try {
      candidateDirs = readdirSync(basePath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && normalize(entry.name).endsWith(suffix))
        .map((entry) => path.join(basePath, entry.name))
    } catch {
      return []
    }
  }

  const matches = []
  for (const candidateDir of candidateDirs) {
    let entries
    try { entries = readdirSync(candidateDir, { withFileTypes: true }) } catch { continue }
    if (entries.some((entry) => blockers.has(normalize(entry.name)))) continue

    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !names.has(normalize(entry.name))) continue
      const filePath = path.join(candidateDir, entry.name)
      try {
        const stats = statSync(filePath)
        if (stats.mtimeMs <= cutoff) matches.push(filePath)
      } catch { /* skip files that change during preview */ }
    }
  }
  return matches
}

const MAX_RECURSIVE_RULE_DIRECTORIES = 100000

function parseAnchorPath(pattern, anchor, normalize) {
  const validName = (name) => typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
  const segments = pattern.split('/')
  if (segments.some((segment) => segment !== '*' && !validName(segment)) || normalize(segments.at(-1) || '') !== anchor) return null
  return segments
}

function expandAnchorPaths(basePath, patterns, budget) {
  const resolved = new Set()

  for (const segments of patterns) {
    let candidates = new Set([basePath])

    for (const segment of segments) {
      const next = new Set()
      for (const candidate of candidates) {
        if (budget.visited >= MAX_RECURSIVE_RULE_DIRECTORIES) break
        budget.visited++

        if (segment === '*') {
          let children
          try { children = readdirSync(candidate, { withFileTypes: true }) } catch { continue }
          for (const child of children) {
            if (!child.isDirectory() || child.isSymbolicLink()) continue
            next.add(path.join(candidate, child.name))
            if (budget.visited + next.size >= MAX_RECURSIVE_RULE_DIRECTORIES) break
          }
        } else {
          const exactPath = path.join(candidate, segment)
          try {
            const stats = lstatSync(exactPath)
            if (stats.isDirectory() && !stats.isSymbolicLink()) next.add(exactPath)
          } catch { /* skip missing or inaccessible candidates */ }
        }
      }
      candidates = next
      if (candidates.size === 0 || budget.visited >= MAX_RECURSIVE_RULE_DIRECTORIES) break
    }

    for (const candidate of candidates) resolved.add(candidate)
    if (budget.visited >= MAX_RECURSIVE_RULE_DIRECTORIES) break
  }

  return [...resolved]
}

function expandRecursiveMatches(basePath, match) {
  const validName = (name) => typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
  if (!match || !validName(match.anchor) || !Array.isArray(match.targets) || match.targets.some((target) => !validName(target)) || (match.excludedAncestors || []).some((ancestor) => !validName(ancestor))) return []

  const normalize = currentPlatform === 'win32' ? (name) => name.toLowerCase() : (name) => name
  const anchor = normalize(match.anchor)
  const targets = new Set(match.targets.map(normalize))
  const excludedAncestors = new Set((match.excludedAncestors || []).map(normalize))
  const maxDepth = Math.min(32, Math.max(1, match.maxDepth || 12))
  const resolved = new Set()
  const budget = { visited: 0 }
  const anchorPaths = match.anchorPaths?.map((pattern) => parseAnchorPath(pattern, anchor, normalize))
  if (anchorPaths?.some((pattern) => pattern === null)) return []
  const roots = anchorPaths
    ? expandAnchorPaths(basePath, anchorPaths.filter((pattern) => pattern !== null), budget).map((rootPath) => ({ path: rootPath, belowAnchor: true }))
    : [{ path: basePath, belowAnchor: normalize(path.basename(basePath)) === anchor }]

  for (const root of roots) {
    const queue = [{ path: root.path, depth: 0, belowAnchor: root.belowAnchor }]
    for (let index = 0; index < queue.length && budget.visited < MAX_RECURSIVE_RULE_DIRECTORIES; index++) {
      const current = queue[index]
      budget.visited++
      let children
      try { children = readdirSync(current.path, { withFileTypes: true }) } catch { continue }

      for (const child of children) {
        if (!child.isDirectory() || child.isSymbolicLink()) continue
        const fullPath = path.join(current.path, child.name)
        const normalized = normalize(child.name)
        const belowAnchor = current.belowAnchor || normalized === anchor

        if (current.belowAnchor && excludedAncestors.has(normalized)) continue

        if (current.belowAnchor && targets.has(normalized)) {
          resolved.add(fullPath)
          continue
        }
        if (current.depth + 1 < maxDepth) queue.push({ path: fullPath, depth: current.depth + 1, belowAnchor })
      }
    }
  }

  return [...resolved]
}

function expandRulePath(basePath, app) {
  if (app.fileMatch) return expandFileMatches(basePath, app.fileMatch)
  if (app.recursiveMatch) return expandRecursiveMatches(basePath, app.recursiveMatch)
  if (!app.childSubdir) return [basePath]

  try {
    return readdirSync(basePath, { withFileTypes: true })
      .filter((child) => child.isDirectory() && !child.isSymbolicLink())
      .map((child) => path.join(basePath, child.name, app.childSubdir))
      .filter((target) => existsSync(target))
  } catch {
    return []
  }
}

function loadAllApps() {
  const platformDir = path.join(RULES_DIR, currentPlatform)
  if (!existsSync(platformDir)) {
    console.error(`No rules directory for platform "${currentPlatform}"`)
    process.exit(1)
  }

  const apps = []
  for (const file of ['apps.json', 'gaming.json', 'gpu-cache.json']) {
    const filePath = path.join(platformDir, file)
    if (!existsSync(filePath)) continue
    const data = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (data.apps) {
      for (const app of data.apps) {
        apps.push(Object.assign({}, app, { _source: file }))
      }
    }
  }
  return apps
}

function main() {
  const targetId = process.argv[2]
  const apps = loadAllApps()

  if (!targetId || targetId === '--list') {
    console.log(`\n📋 Available rule IDs for ${currentPlatform}:\n`)
    const maxName = Math.max.apply(null, apps.map((a) => a.name.length))
    for (const app of apps) {
      console.log(`  ${app.id.padEnd(25)} ${app.name.padEnd(maxName + 2)} (${app._source})`)
    }
    console.log(`\nUsage: npm run preview-rule -- <app-id>`)
    return
  }

  const app = apps.find((a) => a.id === targetId)
  if (!app) {
    console.error(`\nRule "${targetId}" not found for ${currentPlatform}.`)
    console.error(`Run "npm run preview-rule" to see available IDs.\n`)
    process.exit(1)
  }

  const vars = resolveVars()

  console.log(`\n🔎 Kudu — Rule Preview: ${app.name} (${app.id})\n`)
  console.log(`  Source:  ${currentPlatform}/${app._source}`)
  if (app.minAgeDays) console.log(`  minAgeDays: ${app.minAgeDays}`)
  if (app.childSubdir) console.log(`  childSubdir: ${app.childSubdir}`)
  if (app.recursiveMatch) {
    console.log(`  recursiveMatch: ${app.recursiveMatch.anchor}/**/{${app.recursiveMatch.targets.join(', ')}}`)
    if (app.recursiveMatch.anchorPaths) console.log(`  anchorPaths: ${app.recursiveMatch.anchorPaths.join(', ')}`)
    if (app.recursiveMatch.excludedAncestors) console.log(`  excludedAncestors: ${app.recursiveMatch.excludedAncestors.join(', ')}`)
  }
  if (app.fileMatch) {
    console.log(`  fileMatch: ${app.fileMatch.names.join(', ')} (at least ${app.fileMatch.minAgeDays} days old)`)
    if (app.fileMatch.childDirSuffix) console.log(`  childDirSuffix: ${app.fileMatch.childDirSuffix}`)
    if (app.fileMatch.skipIfChildExists) console.log(`  skipIfChildExists: ${app.fileMatch.skipIfChildExists.join(', ')}`)
  }
  if (app.description) console.log(`  Description: ${app.description}`)
  console.log()

  let grandTotal = 0
  let grandFiles = 0

  for (const templatePath of app.paths) {
    const resolved = resolvePath(templatePath, vars)
    console.log(`  📁 ${templatePath}`)
    console.log(`     → ${resolved}`)

    if (!existsSync(resolved)) {
      console.log('     ⚪ Does not exist on this machine\n')
      continue
    }

    if (app.childSubdir || app.recursiveMatch || app.fileMatch) {
      const expanded = expandRulePath(resolved, app)
      if (expanded.length === 0) {
        console.log('     ⚪ No matching cleanup targets\n')
        continue
      }
      for (const target of expanded) {
        const targetStat = statSync(target)
        const { totalSize, fileCount } = targetStat.isDirectory()
          ? getDirStats(target, app.minAgeDays)
          : { totalSize: targetStat.size, fileCount: 1 }
        grandTotal += totalSize
        grandFiles += fileCount
        console.log(`     ↳ ${target}`)
        console.log(`        🟢 ${fileCount} files, ${formatSize(totalSize)}`)
      }
      console.log()
      continue
    }

    const stat = statSync(resolved)
    if (stat.isDirectory()) {
      const { totalSize, fileCount } = getDirStats(resolved, app.minAgeDays)
      grandTotal += totalSize
      grandFiles += fileCount
      console.log(`     🟢 Exists — ${fileCount} files, ${formatSize(totalSize)}`)

      // Show top-level contents
      try {
        const children = readdirSync(resolved).slice(0, 10)
        for (const child of children) {
          const childFull = path.join(resolved, child)
          try {
            const s = statSync(childFull)
            const type = s.isDirectory() ? '📂' : '📄'
            console.log(`        ${type} ${child}  (${formatSize(s.isDirectory() ? getDirStats(childFull, app.minAgeDays).totalSize : s.size)})`)
          } catch { /* skip */ }
        }
        const total = readdirSync(resolved).length
        if (total > 10) console.log(`        ... and ${total - 10} more`)
      } catch { /* skip */ }
    } else {
      grandTotal += stat.size
      grandFiles++
      console.log(`     🟢 Exists — single file, ${formatSize(stat.size)}`)
    }
    console.log()
  }

  console.log('─'.repeat(60))
  console.log(`  Total: ${grandFiles} files, ${formatSize(grandTotal)}`)
  console.log(`  ⚠ DRY RUN — nothing was deleted\n`)
}

main()
