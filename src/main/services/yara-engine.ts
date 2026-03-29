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

/** Embind vector — iterable via .size() and .get(i) */
interface EmbindVector<T> {
  size(): number
  get(i: number): T
}

interface LibYaraResult {
  matchedRules: EmbindVector<{
    ruleName: string
    metadata: EmbindVector<{ identifier: string; data: string }>
    resolvedMatches: EmbindVector<{ location: number; matchLength: number; data: string }>
  }>
  compileErrors: EmbindVector<{ message: string; lineNumber: number; warning: boolean }>
  consoleLogs: EmbindVector<string>
}

interface LibYaraModule {
  run(data: string | Uint8Array, rules: string): LibYaraResult
}

// ─── Engine ──────────────────────────────────────────────────

export class YaraEngine {
  private _module: LibYaraModule | null = null
  private _compiledRules: string = ''
  private _ready = false
  private _rulesLoaded = 0

  /** Load the WASM module. Call once before scanning. */
  async initialize(): Promise<void> {
    try {
      // libyara-wasm exports a factory that returns a ready promise
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const initYara = require('libyara-wasm')
      this._module = await initYara()
      this._ready = true
    } catch (err) {
      console.warn('[yara] WASM initialization failed:', err)
      this._ready = false
      throw err
    }
  }

  isReady(): boolean {
    return this._ready && this._module !== null
  }

  /**
   * Load YARA rules from file paths and/or raw source strings.
   * Returns the number of rules that compiled successfully and any errors.
   */
  loadRules(ruleFilePaths: string[], extraSources: string[] = []): { loaded: number; errors: string[] } {
    if (!this._module) {
      return { loaded: 0, errors: ['YARA engine not initialized'] }
    }

    const errors: string[] = []
    const ruleSources: string[] = []

    for (const filePath of ruleFilePaths) {
      try {
        const source = readFileSync(filePath, 'utf-8')
        ruleSources.push(`// File: ${basename(filePath)}\n${source}`)
      } catch (err) {
        errors.push(`Failed to read ${basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Append cloud / in-memory rule sources
    for (const source of extraSources) {
      ruleSources.push(source)
    }

    if (ruleSources.length === 0) {
      this._compiledRules = ''
      this._rulesLoaded = 0
      return { loaded: 0, errors }
    }

    // Concatenate all rules and test-compile them to check for errors
    const combined = ruleSources.join('\n\n')
    const testResult = this._module.run('', combined)
    const compileErrors = testResult.compileErrors

    let nonWarningErrors = 0
    for (let i = 0; i < compileErrors.size(); i++) {
      const e = compileErrors.get(i)
      if (!e.warning) {
        errors.push(`Compile error (line ${e.lineNumber}): ${e.message}`)
        nonWarningErrors++
      }
    }

    // Count rule declarations in source text
    const ruleCount = (combined.match(/^\s*rule\s+\w+/gm) || []).length

    // If every rule had a compile error, nothing actually compiled — report 0
    if (nonWarningErrors > 0 && nonWarningErrors >= ruleCount) {
      this._compiledRules = ''
      this._rulesLoaded = 0
      return { loaded: 0, errors }
    }

    // Even with partial errors, YARA uses what it can.
    this._compiledRules = combined
    this._rulesLoaded = ruleCount

    return { loaded: ruleCount, errors }
  }

  get rulesLoaded(): number {
    return this._rulesLoaded
  }

  /**
   * Scan a single buffer against loaded YARA rules.
   */
  scanBuffer(buffer: Buffer): YaraMatch[] {
    if (!this._module || !this._compiledRules) return []

    try {
      const result = this._module.run(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), this._compiledRules)
      return this._parseMatches(result)
    } catch (err) {
      console.warn('[yara] Scan error:', err)
      return []
    }
  }

  /**
   * Scan multiple buffers in a single run() call for dramatically better
   * performance. libyara-wasm recompiles rules on every run(), so batching
   * pays the ~400ms compilation cost once instead of per-file.
   *
   * Returns a Map from file index to its matches.
   */
  scanBatch(buffers: Buffer[]): Map<number, YaraMatch[]> {
    const result = new Map<number, YaraMatch[]>()
    if (!this._module || !this._compiledRules || buffers.length === 0) return result

    try {
      // Build a combined buffer and track each file's byte range
      const offsets: number[] = []
      let totalSize = 0
      for (const buf of buffers) {
        offsets.push(totalSize)
        totalSize += buf.length
      }

      const combined = new Uint8Array(totalSize)
      for (let i = 0; i < buffers.length; i++) {
        combined.set(new Uint8Array(buffers[i].buffer, buffers[i].byteOffset, buffers[i].byteLength), offsets[i])
      }

      const scanResult = this._module.run(combined, this._compiledRules)
      const matchedRules = scanResult.matchedRules

      for (let i = 0; i < matchedRules.size(); i++) {
        const rule = matchedRules.get(i)

        // Parse metadata
        const metadata: YaraMatch['metadata'] = {}
        const meta = rule.metadata
        for (let j = 0; j < meta.size(); j++) {
          const m = meta.get(j)
          switch (m.identifier) {
            case 'detectionName': metadata.detectionName = m.data; break
            case 'severity': metadata.severity = m.data as YaraMatch['metadata']['severity']; break
            case 'details': metadata.details = m.data; break
            case 'filenameOnly': metadata.filenameOnly = m.data; break
          }
        }

        // Find which files this rule matched in via string match offsets
        const resolved = rule.resolvedMatches
        const fileIndices = new Set<number>()
        for (let j = 0; j < resolved.size(); j++) {
          const loc = resolved.get(j).location
          // Binary search for the file containing this offset
          let lo = 0, hi = offsets.length - 1
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (offsets[mid] <= loc) lo = mid; else hi = mid - 1
          }
          fileIndices.add(lo)
        }

        // If rule matched via condition-only (no strings, e.g. hash rules),
        // resolvedMatches may be empty — attribute to all files in batch
        if (resolved.size() === 0) {
          for (let k = 0; k < buffers.length; k++) fileIndices.add(k)
        }

        const match: YaraMatch = {
          ruleName: rule.ruleName,
          metadata,
          matchedStrings: [],
        }

        for (const idx of fileIndices) {
          const existing = result.get(idx)
          if (existing) existing.push(match)
          else result.set(idx, [match])
        }
      }
    } catch (err) {
      console.warn('[yara] Batch scan error:', err)
    }

    return result
  }

  private _parseMatches(result: LibYaraResult): YaraMatch[] {
    const matches: YaraMatch[] = []
    const matchedRules = result.matchedRules

    for (let i = 0; i < matchedRules.size(); i++) {
      const rule = matchedRules.get(i)

      // Parse metadata into a typed map
      const metadata: YaraMatch['metadata'] = {}
      const meta = rule.metadata
      for (let j = 0; j < meta.size(); j++) {
        const m = meta.get(j)
        switch (m.identifier) {
          case 'detectionName': metadata.detectionName = m.data; break
          case 'severity': metadata.severity = m.data as YaraMatch['metadata']['severity']; break
          case 'details': metadata.details = m.data; break
          case 'filenameOnly': metadata.filenameOnly = m.data; break
        }
      }

      // Collect matched strings
      const matchedStrings: string[] = []
      const resolved = rule.resolvedMatches
      for (let j = 0; j < resolved.size(); j++) {
        matchedStrings.push(resolved.get(j).data)
      }

      matches.push({
        ruleName: rule.ruleName,
        metadata,
        matchedStrings,
      })
    }

    return matches
  }

  dispose(): void {
    this._module = null
    this._compiledRules = ''
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
