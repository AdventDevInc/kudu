#!/usr/bin/env node

/**
 * GPT-5.4 Translation Script for Kudu i18n
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node scripts/translate.js                    # All languages, all namespaces
 *   OPENAI_API_KEY=sk-... node scripts/translate.js --lang es,fr       # Specific languages
 *   OPENAI_API_KEY=sk-... node scripts/translate.js --ns common,sidebar # Specific namespaces
 *   OPENAI_API_KEY=sk-... node scripts/translate.js --dry-run          # Preview only
 *   OPENAI_API_KEY=sk-... node scripts/translate.js --force            # Re-translate even if unchanged
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// ─── Configuration ──────────────────────────────────────────

const LOCALES_DIR = path.resolve(__dirname, '../src/renderer/src/locales')
const CHECKSUMS_PATH = path.join(LOCALES_DIR, '.checksums.json')
const SOURCE_LANG = 'en'
const MODEL = 'gpt-5.4'
const MAX_CONCURRENT = 3
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
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex')
}

function loadChecksums() {
  try {
    return JSON.parse(fs.readFileSync(CHECKSUMS_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function saveChecksums(checksums) {
  fs.writeFileSync(CHECKSUMS_PATH, JSON.stringify(checksums, null, 2), 'utf-8')
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

  // Load checksums for incremental mode
  const checksums = loadChecksums()
  const failures = []
  let translated = 0
  let skipped = 0

  // Process each language sequentially
  for (const [langCode, langName] of languages) {
    const langDir = path.join(LOCALES_DIR, langCode)
    if (!fs.existsSync(langDir)) {
      fs.mkdirSync(langDir, { recursive: true })
    }

    console.log(`\n── ${langName} (${langCode}) ──`)

    // Build tasks for this language (namespaces to translate)
    const tasks = []

    for (const ns of nsFiles) {
      const enPath = path.join(enDir, `${ns}.json`)
      const enContent = fs.readFileSync(enPath, 'utf-8')
      const enHash = sha256(enContent)
      const checksumKey = `${langCode}/${ns}`

      // Skip if unchanged (unless --force)
      if (!force && checksums[checksumKey] === enHash) {
        const outPath = path.join(langDir, `${ns}.json`)
        if (fs.existsSync(outPath)) {
          console.log(`  [skip] ${ns}.json (unchanged)`)
          skipped++
          continue
        }
      }

      if (dryRun) {
        console.log(`  [would translate] ${ns}.json`)
        continue
      }

      const englishJson = JSON.parse(enContent)

      tasks.push(() =>
        (async () => {
          const start = Date.now()
          let lastError = null

          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              const result = await translateNamespace(ns, langCode, langName, englishJson)

              // Auto-repair dropped interpolation variables (common with RTL languages)
              const repaired = repairTranslation(englishJson, result)
              if (repaired > 0) {
                console.log(`  [repair] ${ns}.json — re-inserted ${repaired} dropped variable(s)`)
              }

              // Validate
              const errors = validateTranslation(englishJson, result, langCode, ns)
              if (errors.length > 0) {
                if (attempt < MAX_RETRIES) {
                  console.log(`  [retry] ${ns}.json — validation errors: ${errors[0]}`)
                  continue
                }
                console.warn(`  [warn] ${ns}.json — validation issues: ${errors.join('; ')}`)
              }

              // Write output
              const outPath = path.join(langDir, `${ns}.json`)
              fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf-8')

              // Update checksum
              checksums[checksumKey] = enHash
              saveChecksums(checksums)

              const elapsed = ((Date.now() - start) / 1000).toFixed(1)
              console.log(`  [done] ${ns}.json (${elapsed}s)`)
              translated++
              return
            } catch (err) {
              lastError = err
              if (err.message?.includes('429') && attempt < MAX_RETRIES) {
                const delay = Math.pow(2, attempt) * 1000
                console.log(`  [rate-limited] ${ns}.json — retrying in ${delay / 1000}s...`)
                await sleep(delay)
              } else if (attempt < MAX_RETRIES) {
                console.log(`  [retry] ${ns}.json — ${err.message}`)
                await sleep(1000)
              }
            }
          }

          console.error(`  [FAILED] ${ns}.json — ${lastError?.message}`)
          failures.push(`${langCode}/${ns}: ${lastError?.message}`)
        })()
      )
    }

    // Run namespace translations concurrently within each language
    if (tasks.length > 0) {
      await withConcurrency(tasks, MAX_CONCURRENT)
    }
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
