#!/usr/bin/env node

/**
 * GPT-5.4 Translation Script for Kudu i18n
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node scripts/translate.js                    # All languages, all namespaces
 *   OPENAI_API_KEY=sk-... node scripts/translate.js --lang es,fr       # Specific languages
 *   OPENAI_API_KEY=sk-... node scripts/translate.js --ns common,sidebar # Specific namespaces
 *   OPENAI_API_KEY=sk-... node scripts/translate.js --dry-run          # Preview only
 *   OPENAI_API_KEY=sk-... node scripts/translate.js --force            # Re-translate every key
 *
 * Incremental by key: only keys that are new or whose English text changed
 * since the last run are sent to the model. Existing translations for
 * untouched keys are kept verbatim, so a PR that adds three strings changes
 * three lines per language instead of rewriting every file (which made
 * every open PR conflict on all locale files).
 *
 * Per-key English hashes live in locales/.checksums.json:
 *   { "version": 2, "keys": { "<namespace>": { "<dot.key>": "<sha256>" } } }
 */

const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')

// ─── Configuration ──────────────────────────────────────────

const LOCALES_DIR = path.resolve(__dirname, '../src/renderer/src/locales')
const CHECKSUMS_PATH = path.join(LOCALES_DIR, '.checksums.json')
const SOURCE_LANG = 'en'
const MODEL = 'gpt-5.4'
const MAX_CONCURRENT = 10
const MAX_RETRIES = 3

const TARGET_LANGUAGES = {
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  'zh-CN': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  ru: 'Russian',
  ar: 'Arabic',
  hi: 'Hindi',
  tr: 'Turkish',
  nl: 'Dutch',
  pl: 'Polish',
  sv: 'Swedish',
  no: 'Norwegian',
  da: 'Danish',
  fi: 'Finnish',
  cs: 'Czech',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
  ms: 'Malay',
  uk: 'Ukrainian',
  ro: 'Romanian',
  el: 'Greek',
  he: 'Hebrew',
  hu: 'Hungarian'
}

// ─── CLI Arguments ──────────────────────────────────────────

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')

function getArgValue(flag) {
  const idx = args.indexOf(flag)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null
}

const langFilter = getArgValue('--lang')?.split(',') ?? null
const nsFilter = getArgValue('--ns')?.split(',') ?? null

// ─── Helpers ────────────────────────────────────────────────

function sha256(content) {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

const CHECKSUMS_VERSION = 2

/**
 * Load per-key English hashes. Older checksum files (one whole-file hash per
 * language/namespace) carry no per-key data, so they are treated as empty and
 * bootstrapped on the first run: keys already present in every target file
 * are assumed current, and only missing keys get translated.
 */
function loadChecksums() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CHECKSUMS_PATH, 'utf-8'))
    if (parsed && parsed.version === CHECKSUMS_VERSION && parsed.keys) return parsed
  } catch {
    /* fall through */
  }
  return { version: CHECKSUMS_VERSION, keys: {} }
}

function saveChecksums(checksums) {
  // Sort namespaces and keys so the file is stable across runs and merges.
  const keys = {}
  for (const ns of Object.keys(checksums.keys).sort()) {
    const entries = checksums.keys[ns]
    keys[ns] = {}
    for (const k of Object.keys(entries).sort()) keys[ns][k] = entries[k]
  }
  fs.writeFileSync(
    CHECKSUMS_PATH,
    JSON.stringify({ version: CHECKSUMS_VERSION, keys }, null, 2) + '\n',
    'utf-8'
  )
}

/** Flatten a nested JSON object into a Map of dot-key -> leaf value */
function flattenEntries(obj, prefix = '') {
  const out = new Map()
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [ck, cv] of flattenEntries(v, fullKey)) out.set(ck, cv)
    } else {
      out.set(fullKey, v)
    }
  }
  return out
}

/** Read a dot-key from a nested object; undefined when absent */
function getPath(obj, dotKey) {
  let cur = obj
  for (const part of dotKey.split('.')) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return undefined
    cur = cur[part]
  }
  return cur
}

/**
 * Build a target-language object that mirrors the English structure and key
 * order, taking values from `fresh` (newly translated) for keys in `keySet`
 * and from `existing` (previous translation) otherwise. Keys no longer in
 * English are dropped. Missing values fall back to English so the app never
 * renders a bare key.
 */
function mergeTranslation(englishJson, existing, fresh, keySet, prefix = '') {
  const out = {}
  for (const [k, enVal] of Object.entries(englishJson)) {
    const fullKey = prefix ? `${prefix}.${k}` : k
    if (enVal && typeof enVal === 'object' && !Array.isArray(enVal)) {
      out[k] = mergeTranslation(
        enVal,
        existing && typeof existing[k] === 'object' ? existing[k] : {},
        fresh && typeof fresh[k] === 'object' ? fresh[k] : {},
        keySet,
        fullKey
      )
      continue
    }
    if (keySet.has(fullKey) && fresh && fresh[k] !== undefined) {
      out[k] = fresh[k]
    } else if (existing && existing[k] !== undefined && typeof existing[k] !== 'object') {
      out[k] = existing[k]
    } else {
      out[k] = enVal
    }
  }
  return out
}

/** Pick only the given dot-keys out of a nested English object, keeping nesting */
function pickKeys(englishJson, keySet, prefix = '') {
  const out = {}
  for (const [k, v] of Object.entries(englishJson)) {
    const fullKey = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const child = pickKeys(v, keySet, fullKey)
      if (Object.keys(child).length > 0) out[k] = child
    } else if (keySet.has(fullKey)) {
      out[k] = v
    }
  }
  return out
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Flatten a nested JSON object into dot-separated keys for validation */
function flattenKeys(obj, prefix = '') {
  const keys = []
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flattenKeys(v, fullKey))
    } else {
      keys.push(fullKey)
    }
  }
  return keys.sort()
}

/** Extract all {{interpolation}} variables from a string */
function extractVars(str) {
  const matches = String(str).match(/\{\{(\w+)\}\}/g) || []
  return matches.sort()
}

/** Recursively extract all {{vars}} from all leaf values in a JSON object */
function extractAllVars(obj) {
  const vars = {}
  function walk(o, prefix = '') {
    for (const [k, v] of Object.entries(o)) {
      const fullKey = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        walk(v, fullKey)
      } else if (typeof v === 'string') {
        const found = extractVars(v)
        if (found.length > 0) vars[fullKey] = found
      }
    }
  }
  walk(obj)
  return vars
}

// ─── Translation via OpenAI ─────────────────────────────────

async function translateNamespace(namespace, targetLang, targetLangName, englishJson) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error('Error: OPENAI_API_KEY environment variable is required')
    process.exit(1)
  }

  const systemPrompt = `You are a professional translator for "Kudu", a free, open-source desktop system cleaner and optimization tool for Windows, macOS, and Linux. Kudu helps users clean junk files, fix registry issues (Windows), manage startup programs, scan for malware, harden privacy settings, uninstall programs, monitor system performance, manage drivers, and schedule automated maintenance tasks. It has a cloud dashboard feature for managing multiple devices. The target audience is everyday computer users who want to keep their systems running fast and clean.

Translate the following JSON values from English to ${targetLangName}. Rules:
- Keep all JSON keys exactly as-is (do not translate keys)
- Keep interpolation variables like {{count}}, {{name}}, {{size}}, {{version}} exactly unchanged — these are replaced at runtime
- Keep brand names unchanged: Kudu, Windows, macOS, Linux, Chrome, Firefox, PowerShell, winget, Homebrew, Microsoft Store, GitHub, S.M.A.R.T., SFC, DISM, UAC, Defender, ClamAV, LLMNR, WPAD, SMBv1, RDP, Hyper-V, Xbox, Cortana, Copilot, Recall, DPAPI, Keychain
- Keep technical abbreviations unchanged: DNS, ARP, CPU, GPU, RAM, PID, IP, CIDR, SSH, USB, SSD, HDD, API, IPC, URI, URL, HTTP, HTTPS
- Use formal but accessible tone — like a polished desktop utility, not overly casual or overly technical
- For OS/computing terms (registry, cache, malware, firewall, telemetry, driver, service, startup, quarantine, etc.), use the standard localized term commonly used in ${targetLangName} operating systems and security software
- For UI terms (scan, clean, fix, remove, uninstall, update, etc.), use the standard verb forms found in ${targetLangName} OS interfaces
- Preserve the exact JSON structure (nesting, objects, etc.)
- Preserve any HTML-like content or special characters within strings
- Keep unit formats contextually appropriate (e.g., time formats like "5m ago", file sizes)
- Return ONLY the translated JSON object, no additional text or explanation`

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(englishJson, null, 2) }
      ]
    })
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`OpenAI API error ${response.status}: ${text}`)
  }

  const data = await response.json()
  return JSON.parse(data.choices[0].message.content)
}

// ─── Validation & Repair ────────────────────────────────────

/**
 * Auto-repair translated JSON by re-inserting missing {{variables}}.
 * LLMs (especially with RTL languages) sometimes drop or translate
 * interpolation placeholders. This walks both trees and patches the
 * translated value so the variable is present.
 */
function repairTranslation(englishJson, translatedJson) {
  let repaired = 0

  function walk(en, tr) {
    for (const [k, enVal] of Object.entries(en)) {
      if (tr[k] === undefined) continue
      if (enVal && typeof enVal === 'object' && !Array.isArray(enVal)) {
        walk(enVal, tr[k])
      } else if (typeof enVal === 'string' && typeof tr[k] === 'string') {
        const enVars = enVal.match(/\{\{\w+\}\}/g) || []
        if (enVars.length === 0) continue
        for (const v of enVars) {
          if (!tr[k].includes(v)) {
            // Variable was dropped — append it to the translated string
            tr[k] = tr[k].trimEnd() + ' ' + v
            repaired++
          }
        }
      }
    }
  }

  walk(englishJson, translatedJson)
  return repaired
}

function validateTranslation(englishJson, translatedJson, langCode, namespace) {
  const errors = []

  // Check keys match
  const enKeys = flattenKeys(englishJson)
  const trKeys = flattenKeys(translatedJson)

  const missingKeys = enKeys.filter((k) => !trKeys.includes(k))
  const extraKeys = trKeys.filter((k) => !enKeys.includes(k))

  if (missingKeys.length > 0) {
    errors.push(`Missing keys: ${missingKeys.join(', ')}`)
  }
  if (extraKeys.length > 0) {
    errors.push(`Extra keys: ${extraKeys.join(', ')}`)
  }

  // Check interpolation variables preserved (after repair, so this catches structural issues only)
  const enVars = extractAllVars(englishJson)
  const trVars = extractAllVars(translatedJson)

  for (const [key, vars] of Object.entries(enVars)) {
    const translated = trVars[key] || []
    const missing = vars.filter((v) => !translated.includes(v))
    if (missing.length > 0) {
      errors.push(`Key "${key}": missing interpolation vars ${missing.join(', ')}`)
    }
  }

  return errors
}

// ─── Concurrency Limiter ────────────────────────────────────

async function withConcurrency(tasks, limit) {
  const results = []
  const executing = new Set()

  for (const task of tasks) {
    const p = task().then((r) => {
      executing.delete(p)
      return r
    })
    executing.add(p)
    results.push(p)

    if (executing.size >= limit) {
      await Promise.race(executing)
    }
  }

  return Promise.all(results)
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  // Discover English namespace files
  const enDir = path.join(LOCALES_DIR, SOURCE_LANG)
  const nsFiles = fs
    .readdirSync(enDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .filter((ns) => !nsFilter || nsFilter.includes(ns))

  const languages = Object.entries(TARGET_LANGUAGES).filter(
    ([code]) => !langFilter || langFilter.includes(code)
  )

  if (nsFiles.length === 0) {
    console.error('No namespace files found to translate.')
    process.exit(1)
  }

  if (languages.length === 0) {
    console.error('No target languages selected.')
    process.exit(1)
  }

  console.log(`\nKudu i18n Translation Script`)
  console.log(`Model: ${MODEL}`)
  console.log(`Namespaces: ${nsFiles.join(', ')}`)
  console.log(`Languages: ${languages.map(([c, n]) => `${c} (${n})`).join(', ')}`)
  console.log(`Mode: ${dryRun ? 'DRY RUN' : force ? 'FORCE' : 'INCREMENTAL'}\n`)

  // Per-key English hashes drive incremental mode
  const checksums = loadChecksums()
  const failures = []
  let translated = 0
  let skipped = 0

  // Build all tasks across all languages and namespaces
  const tasks = []
  // Per namespace: the English hash for every key, and whether every
  // language finished cleanly (only then are the stored hashes advanced, so a
  // failed language is retried next run instead of silently left stale).
  const nsState = {}

  for (const ns of nsFiles) {
    const enPath = path.join(enDir, `${ns}.json`)
    const englishJson = JSON.parse(fs.readFileSync(enPath, 'utf-8'))
    const enEntries = flattenEntries(englishJson)
    const enHashes = {}
    for (const [k, v] of enEntries) enHashes[k] = sha256(String(v))
    const stored = checksums.keys[ns]
    nsState[ns] = { enHashes, failed: false, stored }

    for (const [langCode, langName] of languages) {
      const langDir = path.join(LOCALES_DIR, langCode)
      if (!fs.existsSync(langDir)) {
        fs.mkdirSync(langDir, { recursive: true })
      }
      const outPath = path.join(langDir, `${ns}.json`)
      let existing = {}
      try {
        existing = JSON.parse(fs.readFileSync(outPath, 'utf-8'))
      } catch {
        existing = {}
      }

      // Decide which keys this language needs. With no stored hashes for the
      // namespace (first run after migrating from whole-file checksums) only
      // missing keys are translated; changed wording can't be detected yet.
      const toTranslate = new Set()
      for (const k of enEntries.keys()) {
        const present = getPath(existing, k) !== undefined
        const changed = stored ? stored[k] !== enHashes[k] : false
        if (force || !present || changed) toTranslate.add(k)
      }

      // Structural sync (dropped keys, reordering) happens even with nothing
      // to translate, so the file always mirrors English.
      const synced = mergeTranslation(englishJson, existing, {}, new Set())
      const syncedText = JSON.stringify(synced, null, 2) + '\n'

      if (toTranslate.size === 0) {
        let currentText = ''
        try {
          currentText = fs.readFileSync(outPath, 'utf-8')
        } catch {
          currentText = ''
        }
        if (currentText !== syncedText) {
          if (dryRun) {
            console.log(`  [would sync] ${langCode}/${ns}.json (structure only)`)
          } else {
            fs.writeFileSync(outPath, syncedText, 'utf-8')
            console.log(`  [sync] ${langCode}/${ns}.json (structure only)`)
          }
        } else {
          skipped++
        }
        continue
      }

      if (dryRun) {
        console.log(
          `  [would translate] ${langCode}/${ns}.json — ${toTranslate.size} key(s): ${[...toTranslate].slice(0, 5).join(', ')}${toTranslate.size > 5 ? ', …' : ''}`
        )
        continue
      }

      const subset = pickKeys(englishJson, toTranslate)

      tasks.push(() =>
        (async () => {
          const start = Date.now()
          let lastError = null

          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              const fresh = await translateNamespace(ns, langCode, langName, subset)

              // Auto-repair dropped interpolation variables (common with RTL languages)
              const repaired = repairTranslation(subset, fresh)
              if (repaired > 0) {
                console.log(
                  `  [repair] ${langCode}/${ns}.json — re-inserted ${repaired} dropped variable(s)`
                )
              }

              // Validate the subset the model was asked for
              const errors = validateTranslation(subset, fresh, langCode, ns)
              if (errors.length > 0) {
                if (attempt < MAX_RETRIES) {
                  console.log(`  [retry] ${langCode}/${ns}.json — validation errors: ${errors[0]}`)
                  continue
                }
                console.warn(
                  `  [warn] ${langCode}/${ns}.json — validation issues: ${errors.join('; ')}`
                )
              }

              // Merge fresh keys into the existing translation and write
              const merged = mergeTranslation(englishJson, existing, fresh, toTranslate)
              fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8')

              const elapsed = ((Date.now() - start) / 1000).toFixed(1)
              console.log(
                `  [done] ${langCode}/${ns}.json — ${toTranslate.size} key(s) (${elapsed}s)`
              )
              translated++
              return
            } catch (err) {
              lastError = err
              if (err.message?.includes('429') && attempt < MAX_RETRIES) {
                const delay = Math.pow(2, attempt) * 1000
                console.log(
                  `  [rate-limited] ${langCode}/${ns}.json — retrying in ${delay / 1000}s...`
                )
                await sleep(delay)
              } else if (attempt < MAX_RETRIES) {
                console.log(`  [retry] ${langCode}/${ns}.json — ${err.message}`)
                await sleep(1000)
              }
            }
          }

          console.error(`  [FAILED] ${langCode}/${ns}.json — ${lastError?.message}`)
          failures.push(`${langCode}/${ns}: ${lastError?.message}`)
          nsState[ns].failed = true
        })()
      )
    }
  }

  // Run all translations concurrently across all languages and namespaces
  if (tasks.length > 0) {
    await withConcurrency(tasks, MAX_CONCURRENT)
  }

  // Advance stored hashes for namespaces where every language succeeded.
  // (Only when a namespace or language filter is not narrowing the run: a
  // partial run must not mark keys as done for languages it never touched.)
  if (!dryRun && !langFilter) {
    for (const [ns, state] of Object.entries(nsState)) {
      if (!state.failed) checksums.keys[ns] = state.enHashes
    }
    saveChecksums(checksums)
  }

  // Summary
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Translation complete!`)
  console.log(`  Translated: ${translated}`)
  console.log(`  Skipped:    ${skipped}`)
  if (failures.length > 0) {
    console.log(`  Failed:     ${failures.length}`)
    for (const f of failures) {
      console.log(`    - ${f}`)
    }
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
