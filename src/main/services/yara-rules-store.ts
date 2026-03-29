import { readFileSync, writeFileSync, renameSync, unlinkSync, rmSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { app } from 'electron'

// ─── Constants ───────────────────────────────────────────────

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024 // 50 MB
const MAX_RULE_CONTENT_BYTES = 1 * 1024 * 1024 // 1 MB per rule file
const MAX_RULE_COUNT = 10_000
const DOWNLOAD_TIMEOUT_MS = 60_000
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours
export const RULES_ENDPOINT = '/api/yara-rules'

// ─── Types ───────────────────────────────────────────────────

export interface YaraRuleFile {
  filename: string
  content: string
}

export interface YaraRuleBundle {
  version: string
  updatedAt: string
  sha256: string
  rules: YaraRuleFile[]
}

interface YaraRulesMetadata {
  version: string
  updatedAt: string
  rulesCount: number
  sha256: string
}

// ─── Paths ───────────────────────────────────────────────────

let _dataDir: string | null = null

function getDataDir(): string {
  if (!_dataDir) {
    _dataDir = app.isPackaged
      ? app.getPath('userData')
      : join(app.getPath('userData'), 'Kudu-Dev')
  }
  return _dataDir
}

function getCachedRulesDir(): string {
  return join(getDataDir(), 'yara-rules')
}

function getMetadataPath(): string {
  return join(getCachedRulesDir(), 'metadata.json')
}

/** List .yar files in a directory. */
function listYarFiles(dir: string): string[] {
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(f => f.endsWith('.yar'))
      .sort()
      .map(f => join(dir, f))
  } catch {
    return []
  }
}

// ─── Cached rule files (downloaded from cloud, persisted to disk) ──

/** Get paths to cached YARA rule files. */
export function getCachedRulePaths(): string[] {
  return listYarFiles(getCachedRulesDir())
}

/**
 * Get all YARA rule file paths.
 * Rules are downloaded from the cloud on first launch and cached locally.
 */
export function getAllRulePaths(): string[] {
  return getCachedRulePaths()
}

export function getRulesMetadata(): YaraRulesMetadata | null {
  try {
    const path = getMetadataPath()
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!validateMetadata(parsed)) return null
    return parsed as YaraRulesMetadata
  } catch {
    return null
  }
}

function validateMetadata(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const obj = raw as Record<string, unknown>
  return (
    typeof obj.version === 'string' && obj.version.length > 0 && obj.version.length <= 100 &&
    typeof obj.updatedAt === 'string' && obj.updatedAt.length > 0 && obj.updatedAt.length <= 100 &&
    typeof obj.rulesCount === 'number' && obj.rulesCount >= 0 &&
    typeof obj.sha256 === 'string' && obj.sha256.length > 0 && obj.sha256.length <= 128
  )
}

// ─── Bundle validation ───────────────────────────────────────

export function validateRuleBundle(raw: unknown): YaraRuleBundle | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null

  const obj = raw as Record<string, unknown>
  if (typeof obj.version !== 'string' || obj.version.length === 0 || obj.version.length > 100) return null
  if (typeof obj.updatedAt !== 'string' || obj.updatedAt.length === 0 || obj.updatedAt.length > 100) return null
  if (typeof obj.sha256 !== 'string' || obj.sha256.length === 0 || obj.sha256.length > 128) return null

  if (!Array.isArray(obj.rules) || obj.rules.length === 0 || obj.rules.length > MAX_RULE_COUNT) return null

  const rules: YaraRuleFile[] = []
  for (const item of obj.rules) {
    if (typeof item !== 'object' || item === null) return null
    const entry = item as Record<string, unknown>
    if (typeof entry.filename !== 'string' || !entry.filename.endsWith('.yar')) return null
    if (typeof entry.content !== 'string' || entry.content.length === 0) return null
    if (entry.content.length > MAX_RULE_CONTENT_BYTES) return null
    if (entry.filename.includes('/') || entry.filename.includes('\\') || entry.filename.includes('..')) return null
    rules.push({ filename: entry.filename, content: entry.content })
  }

  return {
    version: obj.version,
    updatedAt: obj.updatedAt,
    sha256: obj.sha256,
    rules,
  }
}

/**
 * Compute the expected SHA-256 hash for a rule bundle.
 * Hash is over concatenated content fields, sorted by filename.
 */
export function computeBundleHash(rules: YaraRuleFile[]): string {
  // Use plain < > comparison (not localeCompare) for deterministic cross-platform sorting
  const sorted = [...rules].sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)
  const combined = sorted.map(r => r.content).join('')
  return createHash('sha256').update(combined).digest('hex')
}

// ─── Cloud fetch + disk caching ──────────────────────────────

/**
 * Fetch YARA rules from a URL, validate integrity, and cache to disk.
 * Sends X-Kudu-Rules-Version header so the server can return 304 if current.
 */
export async function fetchAndCacheRules(url: string): Promise<{
  success: boolean
  error?: string
  stats?: { rulesCount: number; version: string }
}> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

    let text: string
    try {
      const meta = getRulesMetadata()
      const headers: Record<string, string> = { 'Accept': 'application/json' }
      if (meta) headers['X-Kudu-Rules-Version'] = meta.version

      // Disable redirects to prevent SSRF bypass (a public URL could 30x to loopback)
      const response = await fetch(url, { signal: controller.signal, headers, redirect: 'error' })

      // 304 = already up to date
      if (response.status === 304) {
        return { success: true }
      }

      if (!response.ok) {
        return { success: false, error: `Download failed: HTTP ${response.status}` }
      }

      const contentLength = response.headers.get('content-length')
      if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
        return { success: false, error: 'Rules bundle too large (exceeds 50 MB)' }
      }

      // The 60s abort timer stays active through the body read, so a slow
      // server can't hold us indefinitely. That plus the content-length
      // pre-check is sufficient — no need for a post-read size check since
      // the memory is already allocated by that point.
      text = await response.text()
    } finally {
      clearTimeout(timeout)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { success: false, error: 'Invalid rules bundle: JSON parse error' }
    }

    const bundle = validateRuleBundle(parsed)
    if (!bundle) {
      return { success: false, error: 'Invalid rules bundle: validation failed' }
    }

    // Verify integrity
    const computedHash = computeBundleHash(bundle.rules)
    if (computedHash !== bundle.sha256) {
      console.warn(`[yara] SHA-256 mismatch — server: ${bundle.sha256}, computed: ${computedHash}`)
      console.warn(`[yara] Rule files (sorted): ${[...bundle.rules].sort((a, b) => a.filename.localeCompare(b.filename)).map(r => `${r.filename}(${r.content.length})`).join(', ')}`)
      return { success: false, error: 'Integrity check failed: SHA-256 mismatch' }
    }

    // Write rules atomically: stage in a uniquely-named temp directory,
    // then swap into place. Unique name prevents races between concurrent updates.
    const dir = getCachedRulesDir()
    const stageDir = `${dir}.staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    mkdirSync(stageDir, { recursive: true })

    try {
      // Write all rule files + metadata into the staging directory
      for (const rule of bundle.rules) {
        writeFileSync(join(stageDir, rule.filename), rule.content, 'utf-8')
      }
      writeFileSync(join(stageDir, 'metadata.json'), JSON.stringify({
        version: bundle.version,
        updatedAt: bundle.updatedAt,
        rulesCount: bundle.rules.length,
        sha256: bundle.sha256,
      }, null, 2), 'utf-8')

      // Swap: remove old cache dir, rename staging into place
      const oldDir = `${dir}.old-${Date.now()}`
      if (existsSync(dir)) renameSync(dir, oldDir)
      renameSync(stageDir, dir)
      // Clean up old dir in the background
      if (existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true })
    } catch (err) {
      // Clean up staging dir on failure
      try { rmSync(stageDir, { recursive: true, force: true }) } catch { /* best effort */ }
      throw err
    }

    return {
      success: true,
      stats: { rulesCount: bundle.rules.length, version: bundle.version },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: `Download failed: ${msg}`.slice(0, 200) }
  }
}

// ─── Periodic rule updates ───────────────────────────────────

let _checkInterval: ReturnType<typeof setInterval> | null = null
let _onRulesUpdated: (() => void) | null = null

/**
 * Start periodic checks for new YARA rules from the cloud.
 * @param serverUrl  Base URL of the Kudu cloud server
 * @param onUpdated  Callback fired when new rules are downloaded (so the engine can reload)
 * @param intervalMs How often to check (default: 6 hours)
 */
export function startPeriodicRuleChecks(
  serverUrl: string,
  onUpdated: () => void,
  intervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
): void {
  stopPeriodicRuleChecks()
  _onRulesUpdated = onUpdated

  const check = async () => {
    try {
      const result = await fetchAndCacheRules(`${serverUrl}${RULES_ENDPOINT}`)
      if (result.success && result.stats) {
        console.log(`[yara] Updated rules to v${result.stats.version} (${result.stats.rulesCount} rules)`)
        _onRulesUpdated?.()
      }
    } catch (err) {
      console.warn('[yara] Periodic rule check failed:', err)
    }
  }

  // Run first check shortly after launch so rules are available quickly.
  // Rules are no longer bundled — they must be downloaded from the cloud.
  setTimeout(check, 5_000)
  _checkInterval = setInterval(check, intervalMs)
}

export function stopPeriodicRuleChecks(): void {
  if (_checkInterval) {
    clearInterval(_checkInterval)
    _checkInterval = null
  }
  _onRulesUpdated = null
}
