import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { Worker, isMainThread } from 'worker_threads'

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
  compile(source: string): YaraXScanner
}

interface PendingWorkerRequest {
  resolve: (value: any) => void
  reject: (error: Error) => void
  onProgress?: (loaded: number, total: number) => void
}

interface YaraEngineOptions {
  /** Disable the worker inside the worker entry itself and in focused tests. */
  background?: boolean
}

// ─── Engine ──────────────────────────────────────────────────

export class YaraEngine {
  private _scanner: YaraXScanner | null = null
  private _worker: Worker | null = null
  private _pending = new Map<number, PendingWorkerRequest>()
  private _nextRequestId = 1
  private readonly _background: boolean
  private _lastRuleConfig: { ruleFilePaths: string[]; extraSources: string[] } | null = null
  private _recoveryPromise: Promise<void> | null = null
  private _leases = 0
  private _retired = false
  private _disposed = false
  private _ready = false
  private _rulesLoaded = 0

  constructor(options: YaraEngineOptions = {}) {
    // Vitest runs the source directly, where the bundled worker entry does not
    // exist. Electron main/CLI builds use the worker by default.
    this._background = options.background ?? (Boolean(process.versions.electron) && isMainThread)
  }

  /** Create the scanner instance. Call once before loading rules. */
  async initialize(): Promise<void> {
    if (this._background) {
      try {
        await this._initializeWorker()
        return
      } catch (error) {
        // A missing/corrupt worker bundle must degrade scanner performance, not
        // disable protection. Keep the inline path as a last-resort fallback.
        console.warn('[yara] Background worker unavailable, using inline engine:', error)
        this._worker = null
      }
    }

    this._initializeInline()
  }

  private _initializeInline(): void {
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

  private _initializeWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Rollup emits shared main-process code under out/main/chunks while the
      // configured worker entry stays at out/main/yara-worker.js. Keep the
      // adjacent candidate for unchunked/dev layouts as well.
      const adjacentWorker = join(__dirname, 'yara-worker.js')
      const workerPath = existsSync(adjacentWorker)
        ? adjacentWorker
        : join(__dirname, '..', 'yara-worker.js')
      const worker = new Worker(workerPath)
      let settled = false

      const failStartup = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }

      worker.once('error', failStartup)
      worker.on('message', (message: any) => {
        if (message?.type === 'ready' && !settled) {
          settled = true
          worker.removeListener('error', failStartup)
          worker.on('error', (error) => this._failWorker(error))
          this._worker = worker
          this._ready = true
          resolve()
          return
        }
        if (message?.type === 'startup-error' && !settled) {
          void worker.terminate()
          failStartup(new Error(message.error || 'YARA worker failed to start'))
          return
        }
        this._handleWorkerMessage(message)
      })
      worker.once('exit', (code) => {
        if (!settled) {
          failStartup(new Error(`YARA worker exited during startup (${code})`))
        } else if (code !== 0 && this._worker === worker) {
          this._failWorker(new Error(`YARA worker exited unexpectedly (${code})`))
        }
      })
    })
  }

  private _handleWorkerMessage(message: any): void {
    if (!message || typeof message.id !== 'number') return
    const pending = this._pending.get(message.id)
    if (!pending) return
    if (message.type === 'progress') {
      pending.onProgress?.(message.loaded, message.total)
      return
    }
    this._pending.delete(message.id)
    if (message.type === 'error') {
      pending.reject(new Error(message.error || 'YARA worker request failed'))
    } else if (message.type === 'result') {
      pending.resolve(message.result)
    }
  }

  private _failWorker(error: Error): void {
    this._worker = null
    this._ready = false
    for (const pending of this._pending.values()) pending.reject(error)
    this._pending.clear()
    if (this._canRecover()) {
      void this._startRecovery(error).catch(() => {})
    }
  }

  private _canRecover(): boolean {
    return !this._disposed
      && this._lastRuleConfig !== null
      && (!this._retired || this._leases > 0)
  }

  private _startRecovery(cause: Error): Promise<void> {
    if (this._recoveryPromise) return this._recoveryPromise
    const recovery = this._recoverAfterWorkerFailure(cause)
    this._recoveryPromise = recovery
    void recovery
      .catch((error) => console.warn('[yara] Background recovery failed:', error))
      .finally(() => {
        if (this._recoveryPromise === recovery) this._recoveryPromise = null
      })
    return recovery
  }

  private async _recoverAfterWorkerFailure(cause: Error): Promise<void> {
    const config = this._lastRuleConfig
    if (!config || !this._canRecover()) throw cause

    console.warn('[yara] Worker failed; restarting scanner:', cause.message)
    try {
      await this._initializeWorker()
      if (!this._canRecover()) throw new Error('YARA engine retired during recovery')
      const result = await this._requestWorker<{ loaded: number; errors: string[] }>({
        type: 'load-rules',
        ruleFilePaths: config.ruleFilePaths,
        extraSources: config.extraSources,
      })
      if (result.loaded === 0) throw new Error('Recovered YARA worker loaded no rules')
      this._rulesLoaded = result.loaded
      this._ready = true
      return
    } catch (workerError) {
      if (!this._canRecover()) throw workerError
      console.warn('[yara] Worker restart failed; using inline fallback:', workerError)
      if (this._worker) void this._worker.terminate()
      this._worker = null
      this._scanner = null
      this._initializeInline()
      const result = await this._loadRulesInline(config.ruleFilePaths, config.extraSources)
      if (result.loaded === 0) throw new Error('Inline YARA fallback loaded no rules')
    }
  }

  private _requestWorker<T>(
    message: Record<string, unknown>,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<T> {
    const worker = this._worker
    if (!worker) return Promise.reject(new Error('YARA worker is not running'))
    const id = this._nextRequestId++
    return new Promise<T>((resolve, reject) => {
      this._pending.set(id, { resolve, reject, onProgress })
      worker.postMessage({ ...message, id })
    })
  }

  isReady(): boolean {
    return this._ready && (this._scanner !== null || this._worker !== null)
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
    if (this._worker) {
      const result = await this._requestWorker<{ loaded: number; errors: string[] }>({
        type: 'load-rules',
        ruleFilePaths,
        extraSources,
      }, onProgress)
      this._rulesLoaded = result.loaded
      if (result.loaded > 0) this._rememberRules(ruleFilePaths, extraSources)
      return result
    }

    const result = await this._loadRulesInline(ruleFilePaths, extraSources, onProgress)
    if (result.loaded > 0) this._rememberRules(ruleFilePaths, extraSources)
    return result
  }

  private _rememberRules(ruleFilePaths: string[], extraSources: string[]): void {
    this._lastRuleConfig = {
      ruleFilePaths: [...ruleFilePaths],
      extraSources: [...extraSources],
    }
  }

  private async _loadRulesInline(
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
      // stderr, not stdout — keeps the CLI's --json output parseable.
      console.error(`[yara] Skipped ${skippedPlatform} rule files for other platforms`)
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
   * Scan a file from an in-memory snapshot.
   *
   * The native `scanFile` API keeps an OS file handle while scanning. If a
   * cleaner runs concurrently, that makes the malware scanner itself an owner
   * of the file it is trying to remove. `readFileSync` closes its handle before
   * native pattern matching starts, eliminating that overlap.
   */
  scanFile(filePath: string): YaraMatch[] {
    if (!this._scanner) return []

    try {
      const contents = readFileSync(filePath)
      const results = this._scanner.scan(contents)
      return results.map(r => this._convertMatch(r))
    } catch (err) {
      console.warn('[yara] File scan error:', err)
      return []
    }
  }

  /** Run native file matching away from Electron's main thread when available. */
  async scanFileAsync(filePath: string): Promise<YaraMatch[]> {
    if (this._recoveryPromise) await this._recoveryPromise
    if (!this._worker && !this._scanner && this._canRecover()) {
      await this._startRecovery(new Error('YARA scanner backend is unavailable'))
    }
    if (this._worker) {
      return this._requestWorker<YaraMatch[]>({ type: 'scan-file', filePath })
    }
    if (!this._scanner) return []
    try {
      const contents = readFileSync(filePath)
      const results = await this._scanner.scanAsync(contents)
      return results.map(r => this._convertMatch(r))
    } catch (err) {
      console.warn('[yara] Async file scan error:', err)
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

  /** Keep a retired engine alive until an in-flight malware scan releases it. */
  acquire(): () => void {
    if (this._retired || this._disposed) throw new Error('YARA engine is retired')
    this._leases++
    let released = false
    return () => {
      if (released) return
      released = true
      this._leases = Math.max(0, this._leases - 1)
      if (this._retired && this._leases === 0) this.dispose()
    }
  }

  retire(): void {
    if (this._retired || this._disposed) return
    this._retired = true
    if (this._leases === 0) this.dispose()
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._retired = true
    if (this._worker) {
      void this._worker.terminate()
      this._worker = null
    }
    for (const pending of this._pending.values()) {
      pending.reject(new Error('YARA engine disposed'))
    }
    this._pending.clear()
    this._scanner = null
    this._lastRuleConfig = null
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
