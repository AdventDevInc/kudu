#!/usr/bin/env node

/**
 * Fetch the latest YARA rules from the Kudu cloud API and write them
 * to resources/yara-rules/ so they get bundled with the installer.
 *
 * Usage:
 *   node scripts/fetch-yara-rules.js                       # uses default URL
 *   KUDU_RULES_URL=https://... node scripts/fetch-yara-rules.js
 *
 * If the API is unreachable, the script exits with code 0 and a warning —
 * the build will succeed without bundled rules (the app still works via
 * the regex fallback and will fetch rules from the cloud at runtime).
 */

const { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } = require('fs')
const { join } = require('path')
const { createHash } = require('crypto')

const RULES_URL = process.env.KUDU_RULES_URL || 'https://cloud.usekudu.com/api/yara-rules'
const OUT_DIR = join(__dirname, '..', 'resources', 'yara-rules')
const TIMEOUT_MS = 30_000

async function main() {
  console.log(`[fetch-yara-rules] Fetching from ${RULES_URL}`)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let body
  try {
    // Keep timeout active through full body read so a stalling server can't hang CI
    const response = await fetch(RULES_URL, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    })

    if (!response.ok) {
      console.warn(`[fetch-yara-rules] API returned ${response.status} — skipping bundled rules`)
      ensureEmptyDir()
      return
    }

    body = await response.json()
  } catch (err) {
    console.warn(`[fetch-yara-rules] Could not reach API — skipping bundled rules (${err.message})`)
    ensureEmptyDir()
    return
  } finally {
    clearTimeout(timeout)
  }

  if (!body.rules || !Array.isArray(body.rules) || body.rules.length === 0) {
    console.warn('[fetch-yara-rules] No rules in response — skipping bundled rules')
    ensureEmptyDir()
    return
  }

  // Verify integrity if sha256 is present
  if (body.sha256) {
    const sorted = [...body.rules].sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)
    const combined = sorted.map(r => r.content).join('')
    const computed = createHash('sha256').update(combined).digest('hex')
    if (computed !== body.sha256) {
      console.error(`[fetch-yara-rules] SHA-256 mismatch — expected ${body.sha256}, got ${computed}`)
      process.exit(1)
    }
  }

  // Write rules — clear stale .yar files first so removed rules don't persist
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
  for (const existing of readdirSync(OUT_DIR)) {
    if (existing.endsWith('.yar')) {
      try { unlinkSync(join(OUT_DIR, existing)) } catch { /* best effort */ }
    }
  }

  let count = 0
  for (const rule of body.rules) {
    if (!rule.filename || !rule.content) continue
    if (!rule.filename.endsWith('.yar')) continue
    if (rule.filename.includes('/') || rule.filename.includes('\\') || rule.filename.includes('..')) continue

    writeFileSync(join(OUT_DIR, rule.filename), rule.content, 'utf-8')
    count++
  }

  console.log(`[fetch-yara-rules] Wrote ${count} rule files to resources/yara-rules/ (v${body.version || 'unknown'})`)
}

function ensureEmptyDir() {
  // Create the directory so electron-builder doesn't fail on missing extraResources,
  // and clear any stale .yar files so revoked rules aren't accidentally packaged.
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true })
    return
  }
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith('.yar')) {
      try { unlinkSync(join(OUT_DIR, f)) } catch { /* best effort */ }
    }
  }
}

main().catch(err => {
  console.warn(`[fetch-yara-rules] Unexpected error — skipping bundled rules (${err.message})`)
  ensureEmptyDir()
})
