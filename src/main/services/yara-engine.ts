import { readFileSync } from 'fs'
import { basename } from 'path'

// ─── Types ───────────────────────────────────────────────────

export interface YaraMatch {
  ruleName: string
  metadata: {
    detectionName?: string
    severity?: 'critical' | 'high' | 'medium' | 'low'
    details?: string
    filenameOnly?: string
  }
  matchedStrings: string[]
}

/** Result shape from @litko/yara-x scan() */
interface YaraXMatch {
  ruleIdentifier: string
  namespace: string
  meta: Record<string, string>
  tags: string[]
  matches: { offset: number; length: number; data: string; identifier: string }[]
}

/** @litko/yara-x scanner instance — rules compiled once, scan many times */
interface YaraXScanner {
  addRuleSource(source: string): void
  addRuleFile(path: string): void
  scan(data: Buffer): YaraXMatch[]
  scanFile(path: string): YaraXMatch[]
  scanAsync(data: Buffer): Promise<YaraXMatch[]>
  scanFileAsync(path: string): Promise<YaraXMatch[]>
  getWarnings(): string[]
}

interface YaraXModule {
  create(): YaraXScanner
}

// ─── Engine ──────────────────────────────────────────────────

export class YaraEngine {
  private _scanner: YaraXScanner | null = null
  private _ready = false
  private _rulesLoaded = 0

  /** Create the scanner instance. Call once before loading rules. */
  async initialize(): Promise<void> {
    try {
      const yarax: YaraXModule = require('@litko/yara-x')
      this._scanner = yarax.create()
      this._ready = true
    } catch (err) {
      console.warn('[yara] @litko/yara-x initialization failed:', err)
      this._ready = false
      throw err
    }
  }

  isReady(): boolean {
    return this._ready && this._scanner !== null
  }

  /**
   * Compile YARA rules from file paths and/or raw source strings.
   *
   * Strategy: concatenate all sources and compile in a single call (~2s).
   * If that fails (bad rule syntax), fall back to per-file validation to
   * find and exclude the broken files, then compile the rest.
   *
   * This is ~240x faster than calling addRuleFile() per file, because
   * addRuleFile recompiles the entire accumulated ruleset on every call.
   *
   * @param onProgress Optional callback fired with (loaded, total) counts
   */
  async loadRules(
    ruleFilePaths: string[],
    extraSources: string[] = [],
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<{ loaded: number; errors: string[] }> {
    if (!this._scanner) {
      return { loaded: 0, errors: ['YARA engine not initialized'] }
    }

    const yarax: YaraXModule = require('@litko/yara-x')
    const errors: string[] = []
    const total = ruleFilePaths.length + extraSources.length

    // Platform filter: skip rule files for other OSes to reduce compilation cost.
    // Files are named like elastic_Linux_Trojan_Mirai.yar or elastic_Windows_Generic.yar.
    // We skip files containing a platform tag that doesn't match the current OS.
    const platformSkip: string[] = []
    if (process.platform !== 'win32') platformSkip.push('_windows_', '_win32_')
    if (process.platform !== 'linux') platformSkip.push('_linux_')
    if (process.platform !== 'darwin') platformSkip.push('_macos_', '_darwin_')

    function shouldSkipForPlatform(name: string): boolean {
      const lower = name.toLowerCase()
      return platformSkip.some(tag => lower.includes(tag))
    }

    // Read all sources (skipping irrelevant platforms)
    onProgress?.(0, total)
    const sources: { name: string; content: string }[] = []
    let skippedPlatform = 0
    for (const filePath of ruleFilePaths) {
      const name = basename(filePath)
      if (shouldSkipForPlatform(name)) { skippedPlatform++; continue }
      try {
        sources.push({ name, content: readFileSync(filePath, 'utf-8') })
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
      }
    }
    for (let i = 0; i < extraSources.length; i++) {
      sources.push({ name: `source-${i}`, content: extraSources[i] })
    }
    if (skippedPlatform > 0) {
      console.log(`[yara] Skipped ${skippedPlatform} rule files for other platforms`)
    }

    if (sources.length === 0) {
      this._rulesLoaded = 0
      return { loaded: 0, errors }
    }

    // Try fast path: compile everything in one call (~2s for 1400 files)
    const combined = sources.map(s => s.content).join('\n')
    try {
      onProgress?.(Math.floor(total * 0.5), total)
      await new Promise(resolve => setImmediate(resolve))
      this._scanner = yarax.compile(combined)
      this._rulesLoaded = sources.length
      onProgress?.(total, total)
      return { loaded: sources.length, errors }
    } catch {
      // Fast path failed — some rule has bad syntax. Fall back to per-file
      // validation to find and exclude broken files.
      console.warn('[yara] Bulk compile failed, falling back to per-file validation...')
    }

    // Slow path: validate each file individually, exclude broken ones
    const validSources: string[] = []
    for (let i = 0; i < sources.length; i++) {
      try {
        yarax.compile(sources[i].content)
        validSources.push(sources[i].content)
      } catch (err) {
        errors.push(`${sources[i].name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
      }
      if ((i + 1) % 20 === 0) {
        onProgress?.(i + 1, total)
        await new Promise(resolve => setImmediate(resolve))
      }
    }

    if (validSources.length === 0) {
      this._rulesLoaded = 0
      return { loaded: 0, errors }
    }

    // Compile the valid rules
    try {
      onProgress?.(total, total)
      this._scanner = yarax.compile(validSources.join('\n'))
    } catch (err) {
      errors.push(`Final compile: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
      this._rulesLoaded = 0
      return { loaded: 0, errors }
    }

    this._rulesLoaded = validSources.length
    return { loaded: validSources.length, errors }
  }

  get rulesLoaded(): number {
    return this._rulesLoaded
  }

  /**
   * Scan a buffer against all compiled rules.
   * Fast — rules are already compiled, only pattern matching runs.
   */
  scanBuffer(buffer: Buffer): YaraMatch[] {
    if (!this._scanner) return []

    try {
      const results = this._scanner.scan(buffer)
      return results.map(r => this._convertMatch(r))
    } catch (err) {
      console.warn('[yara] Scan error:', err)
      return []
    }
  }

  /**
   * Scan a file directly from disk (avoids reading into JS memory).
   */
  scanFile(filePath: string): YaraMatch[] {
    if (!this._scanner) return []

    try {
      const results = this._scanner.scanFile(filePath)
      return results.map(r => this._convertMatch(r))
    } catch (err) {
      console.warn('[yara] File scan error:', err)
      return []
    }
  }

  private _convertMatch(r: YaraXMatch): YaraMatch {
    const metadata: YaraMatch['metadata'] = {}
    if (r.meta.detectionName) metadata.detectionName = String(r.meta.detectionName)
    if (r.meta.severity) {
      const sev = String(r.meta.severity).toLowerCase()
      if (VALID_SEVERITIES.has(sev as any)) metadata.severity = sev as YaraMatch['metadata']['severity']
    }
    if (r.meta.details) metadata.details = String(r.meta.details)
    if (r.meta.filenameOnly) metadata.filenameOnly = String(r.meta.filenameOnly)

    return {
      ruleName: r.ruleIdentifier,
      metadata,
      matchedStrings: r.matches.map(m => m.data),
    }
  }

  dispose(): void {
    this._scanner = null
    this._ready = false
    this._rulesLoaded = 0
  }
}

// ─── Factory ─────────────────────────────────────────────────

export function createYaraEngine(): YaraEngine {
  return new YaraEngine()
}

/**
 * Convert a YaraMatch to the metadata fields used by MalwareThreat.
 * Pure function — safe for testing without Electron.
 */
const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low'] as const)

export function yaraMatchToThreatFields(match: YaraMatch): {
  detectionName: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  details: string
} {
  const rawSeverity = match.metadata.severity
  const severity = rawSeverity && VALID_SEVERITIES.has(rawSeverity) ? rawSeverity : 'high'
  return {
    detectionName: match.metadata.detectionName || match.ruleName.replace(/_/g, '.'),
    severity,
    details: match.metadata.details || `YARA rule match: ${match.ruleName}`,
  }
}
