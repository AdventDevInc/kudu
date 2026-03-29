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
   * Rules are compiled once — subsequent scan() calls are fast.
   *
   * Compilation is chunked with event-loop yields so the main process
   * stays responsive (each addRuleFile takes ~5-8ms, and with 1400+
   * files this would otherwise block the UI for 10+ seconds).
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

    const errors: string[] = []
    let loaded = 0
    const total = ruleFilePaths.length + extraSources.length
    const CHUNK_SIZE = 20 // yield to event loop every N files

    // Load from file paths in chunks
    for (let i = 0; i < ruleFilePaths.length; i++) {
      try {
        this._scanner.addRuleFile(ruleFilePaths[i])
        loaded++
      } catch (err) {
        errors.push(`${basename(ruleFilePaths[i])}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
      }
      // Yield to the event loop periodically so the UI stays responsive
      if ((i + 1) % CHUNK_SIZE === 0) {
        onProgress?.(loaded, total)
        await new Promise(resolve => setImmediate(resolve))
      }
    }

    // Load from source strings
    for (const source of extraSources) {
      try {
        this._scanner.addRuleSource(source)
        loaded++
      } catch (err) {
        errors.push(`source: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
      }
    }

    onProgress?.(loaded, total)
    this._rulesLoaded = loaded
    return { loaded, errors }
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
