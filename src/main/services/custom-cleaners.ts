import { opendir, lstat, realpath } from 'fs/promises'
import { dirname, join, relative, sep } from 'path'
import { randomUUID, createHash } from 'crypto'
import type { Stats } from 'fs'
import { validCustomRule, customRuleId } from '../../shared/custom-cleaners'
import type {
  CustomCleanerRule,
  CustomCleanerPreview,
  CustomCleanerReceipt
} from '../../shared/custom-cleaners'
import type { ScanItem, ScanResult } from '../../shared/types'
import { CustomCleanerStore } from './custom-cleaner-store'
import {
  customRoot,
  customFileMatches,
  customCaseInsensitive,
  sameCustomFile,
  customProtectedName
} from './custom-cleaner-safety'
import type { CustomRootPolicy } from './custom-cleaner-safety'
import { cacheItems, removeCachedItems } from './scan-cache'
import { cleanItems, isExcluded } from './file-utils'
import { mountPoints } from './mount-points'
import { logError } from './logger'

// Hash a fixed projection so key order and the enabled flag never change the fingerprint.
const fingerprint = (r: CustomCleanerRule): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        r.version,
        r.id,
        r.name,
        r.description,
        r.platform,
        r.root,
        r.patterns,
        r.excludePatterns,
        r.excludeDirectories,
        r.minAgeDays,
        r.maxDepth
      ])
    )
    .digest('hex')
/** Rule, root and settings looked up once per clean run rather than once per item. */
interface RunSnapshot {
  rule: CustomCleanerRule | undefined
  root: Awaited<ReturnType<typeof customRoot>> | null
  exclusions: string[]
  recentMinutes: number
  /** Bind mounts share the root's device, so mount points are checked by path as well. */
  mounts: Set<string>
}
interface PreviewContext {
  preview: CustomCleanerPreview
  files: Map<string, Stats>
  directories: Map<string, Stats>
  expires: number
  fingerprint: string
  run?: { expires: number; value: Promise<RunSnapshot> }
}
export class CustomCleaners {
  private contexts = new Map<string, PreviewContext>()
  private controller: AbortController | null = null
  private cleaning = false
  private preparing = false
  constructor(
    readonly store: CustomCleanerStore,
    private policy: CustomRootPolicy,
    private exclusions: () => string[],
    private recentMinutes: () => number
  ) {}
  cancel(): void {
    this.controller?.abort()
  }
  private discard(context: PreviewContext): void {
    removeCachedItems(context.preview.items.map((i) => i.id))
    this.contexts.delete(context.preview.token)
  }
  private context(token: unknown): PreviewContext {
    if (typeof token !== 'string') throw new Error('Invalid preview')
    const ctx = this.contexts.get(token)
    if (!ctx || ctx.expires < Date.now()) {
      if (ctx) this.discard(ctx)
      throw new Error('Preview expired. Scan again.')
    }
    return ctx
  }
  private invalidate(): void {
    for (const ctx of this.contexts.values()) ctx.run = undefined
  }
  private snapshot(ctx: PreviewContext): Promise<RunSnapshot> {
    const now = Date.now()
    if (!ctx.run || ctx.run.expires < now)
      ctx.run = {
        expires: now + 1000,
        value: (async () => {
          const rule = (await this.store.list()).find((r) => r.id === ctx.preview.rule.id)
          const root =
            rule?.enabled && fingerprint(rule) === ctx.fingerprint
              ? await customRoot(rule.root, this.policy)
              : null
          return {
            rule,
            root,
            exclusions: this.exclusions(),
            recentMinutes: this.recentMinutes(),
            mounts: await mountPoints()
          }
        })()
      }
    return ctx.run.value
  }
  private async guard(ctx: PreviewContext, item: ScanItem): Promise<string | null> {
    if (ctx.expires < Date.now() || ctx.preview.state !== 'complete')
      return 'custom-preview-expired-or-incomplete'
    const { rule, root, exclusions, recentMinutes, mounts } = await this.snapshot(ctx)
    if (!rule?.enabled || fingerprint(rule) !== ctx.fingerprint || !root)
      return 'custom-rule-disabled-or-changed'
    const oldRoot = ctx.directories.get(root.path)
    if (!oldRoot || oldRoot.ino !== root.info.ino || oldRoot.dev !== root.info.dev)
      return 'custom-root-changed'
    const original = ctx.files.get(item.id)
    const now = await lstat(item.path)
    if (!original || !sameCustomFile(original, now)) return 'custom-file-changed'
    const cutoff = Date.now() - Math.max(rule.minAgeDays * 86400000, recentMinutes * 60000)
    if (isExcluded(item.path, exclusions) || !customFileMatches(item.path, rule, now, cutoff))
      return 'custom-file-no-longer-eligible'
    if ((await realpath(item.path)) !== item.path) return 'custom-path-changed'
    for (let parent = dirname(item.path); ; parent = dirname(parent)) {
      const old = ctx.directories.get(parent),
        info = await lstat(parent)
      if (
        !old ||
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        old.dev !== info.dev ||
        old.ino !== info.ino
      )
        return 'custom-folder-changed'
      if (parent === rule.root) break
      if (mounts.has(parent)) return 'custom-folder-changed'
    }
    return null
  }
  async preview(value: unknown, deadline = Date.now() + 10000): Promise<CustomCleanerPreview> {
    if (this.controller || this.cleaning || this.preparing)
      throw new Error('A custom-cleaner operation is already running')
    const raw = value as Partial<CustomCleanerRule> | null
    if (!raw || typeof raw !== 'object') throw new Error('Invalid rule')
    const rule = { ...raw, id: raw.id || `custom-${randomUUID()}` } as CustomCleanerRule
    if (!validCustomRule(rule))
      throw new Error(
        'Invalid custom cleaner. Use simple filename patterns, age 1–3650 days, and depth 0–8.'
      )
    if (rule.platform !== this.policy.platform)
      throw new Error(
        'Choose a folder on this operating system before previewing this imported rule.'
      )
    this.preparing = true
    let root: Awaited<ReturnType<typeof customRoot>>
    try {
      root = await customRoot(rule.root, this.policy)
    } finally {
      this.preparing = false
    }
    rule.root = root.path
    const controller = new AbortController()
    this.controller = controller
    const ctx: PreviewContext = {
      preview: {
        token: randomUUID(),
        rule,
        state: 'complete',
        visited: 0,
        items: [],
        itemCount: 0,
        totalSize: 0,
        warnings: []
      },
      files: new Map(),
      directories: new Map([[root.path, root.info]]),
      expires: Date.now() + 600000,
      fingerprint: fingerprint(rule)
    }
    const addWarning = (message: string) => {
      if (!ctx.preview.warnings.includes(message)) ctx.preview.warnings.push(message)
    }
    const cutoff = Date.now() - Math.max(rule.minAgeDays * 86400000, this.recentMinutes() * 60000)
    const exclusions = this.exclusions()
    const caseInsensitive = customCaseInsensitive(rule)
    const mounts = await mountPoints()
    const scan = async (folder: string, depth: number): Promise<void> => {
      if (controller.signal.aborted || ctx.preview.state === 'partial') return
      let directory
      try {
        const info = await lstat(folder)
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          info.dev !== root.info.dev ||
          mounts.has(folder) ||
          (await realpath(folder)) !== folder
        ) {
          addWarning('Aliases and other mounted volumes were skipped.')
          return
        }
        const expected = ctx.directories.get(folder)
        if (expected && (expected.ino !== info.ino || expected.dev !== info.dev))
          throw new Error('changed directory')
        ctx.directories.set(folder, info)
        directory = await opendir(folder)
        for await (const entry of directory) {
          if (controller.signal.aborted) break
          if (
            ++ctx.preview.visited > 50000 ||
            ctx.preview.items.length >= 2000 ||
            Date.now() > deadline
          ) {
            ctx.preview.state = 'partial'
            addWarning('Preview reached its file/time limit. Narrow the folder, depth or patterns.')
            break
          }
          const file = join(folder, entry.name)
          if (customProtectedName(entry.name)) continue
          if (isExcluded(file, exclusions)) continue
          const rel = relative(rule.root, file).split(sep).join('/')
          if (
            rule.excludeDirectories.some((d) =>
              caseInsensitive
                ? rel.toLowerCase() === d.toLowerCase() ||
                  rel.toLowerCase().startsWith(d.toLowerCase() + '/')
                : rel === d || rel.startsWith(d + '/')
            )
          )
            continue
          let info: Stats
          try {
            info = await lstat(file)
          } catch {
            ctx.preview.state = 'partial'
            addWarning('Some entries could not be inspected.')
            break
          }
          if (info.isSymbolicLink()) {
            addWarning('Symbolic links and junctions were skipped.')
            continue
          }
          if (info.isDirectory()) {
            if (depth < rule.maxDepth) await scan(file, depth + 1)
            continue
          }
          if (customFileMatches(file, rule, info, cutoff)) {
            const item: ScanItem = {
              id: randomUUID(),
              path: file,
              size: info.size,
              lastModified: info.mtimeMs,
              category: 'app',
              subcategory: `Custom: ${rule.name}`,
              selected: true,
              recencyCutoff: cutoff,
              fileOnly: true
            }
            ctx.preview.items.push(item)
            ctx.files.set(item.id, info)
            ctx.preview.totalSize += info.size
          }
          if (ctx.preview.visited % 100 === 0)
            await new Promise<void>((resolve) => setImmediate(resolve))
        }
        const after = await lstat(folder)
        if (after.ino !== info.ino || after.dev !== info.dev || after.isSymbolicLink())
          throw new Error('changed directory')
      } catch {
        ctx.preview.state = 'partial'
        addWarning('A folder was inaccessible or changed during preview.')
      }
    }
    try {
      await scan(rule.root, 0)
      if (controller.signal.aborted) ctx.preview.state = 'cancelled'
      ctx.preview.itemCount = ctx.preview.items.length
      for (const old of [...this.contexts.values()])
        if (old.preview.rule.id === rule.id || old.expires < Date.now()) this.discard(old)
      while (this.contexts.size >= 20) this.discard(this.contexts.values().next().value!)
      this.contexts.set(ctx.preview.token, ctx)
      if (ctx.preview.state === 'complete')
        cacheItems(ctx.preview.items, (item) => this.guard(ctx, item))
      return { ...ctx.preview, items: ctx.preview.items.slice(0, 100) }
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }
  page(token: unknown, offset: unknown): ScanItem[] {
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 2000)
      throw new Error('Invalid preview page')
    return this.context(token).preview.items.slice(offset, offset + 100)
  }
  async save(token: unknown): Promise<CustomCleanerRule> {
    const ctx = this.context(token)
    if (ctx.preview.state !== 'complete')
      throw new Error('Complete a bounded preview before saving or enabling this cleaner.')
    const rule = ctx.preview.rule
    await customRoot(rule.root, this.policy)
    await this.store.update((rules) => [...rules.filter((r) => r.id !== rule.id), rule])
    this.invalidate()
    return rule
  }
  async disable(id: unknown): Promise<void> {
    if (!customRuleId(id)) throw new Error('Invalid rule ID')
    await this.store.update((rules) =>
      rules.map((r) => (r.id === id ? { ...r, enabled: false } : r))
    )
    this.invalidate()
  }
  async remove(id: unknown): Promise<void> {
    if (!customRuleId(id)) throw new Error('Invalid rule ID')
    await this.store.update((rules) => rules.filter((r) => r.id !== id))
    this.invalidate()
    for (const ctx of [...this.contexts.values()]) if (ctx.preview.rule.id === id) this.discard(ctx)
  }
  async import(json: string): Promise<number> {
    if (Buffer.byteLength(json) > 131072) throw new Error('Import exceeds 128 KB')
    const data = JSON.parse(json) as { version?: unknown; rules?: unknown }
    if (
      data.version !== 1 ||
      Object.keys(data).some((k) => !['version', 'rules'].includes(k)) ||
      !Array.isArray(data.rules) ||
      data.rules.length < 1 ||
      data.rules.length > 20 ||
      !data.rules.every(validCustomRule)
    )
      throw new Error('Unsupported custom-cleaner file. No definitions were changed.')
    const imported = data.rules.map((r) => ({ ...r, id: `custom-${randomUUID()}`, enabled: false }))
    await this.store.update((rules) => [...rules, ...imported])
    return imported.length
  }
  async clean(token: unknown): Promise<CustomCleanerReceipt> {
    if (this.cleaning || this.controller)
      throw new Error('A custom-cleaner operation is already running')
    const ctx = this.context(token)
    if (ctx.preview.state !== 'complete') throw new Error('Complete the preview before cleaning')
    this.cleaning = true
    this.invalidate()
    const startedAt = new Date().toISOString()
    try {
      const result = await cleanItems(ctx.preview.items.map((i) => i.id))
      return {
        ruleId: ctx.preview.rule.id,
        ruleName: ctx.preview.rule.name,
        startedAt,
        finishedAt: new Date().toISOString(),
        selected: ctx.preview.items.length,
        result
      }
    } finally {
      this.cleaning = false
      this.discard(ctx)
    }
  }
  async appScans(): Promise<ScanResult[]> {
    const results: ScanResult[] = []
    const deadline = Date.now() + 30000
    let remaining = 10000
    let rules: CustomCleanerRule[]
    try {
      rules = await this.store.list()
    } catch (e) {
      logError('Custom cleaners skipped: definitions could not be read', e)
      return []
    }
    // One bad definition must never fail the whole Applications scan, including bundled rules.
    for (const rule of rules.filter((r) => r.enabled && r.platform === this.policy.platform)) {
      if (Date.now() > deadline || remaining <= 0) {
        logError(
          `Custom cleaner ${rule.name} skipped: scan limit reached. Narrow or disable rules.`
        )
        continue
      }
      try {
        const preview = await this.preview(rule, Math.min(deadline, Date.now() + 10000))
        if (preview.state !== 'complete')
          throw new Error(`Custom cleaner ${rule.name} needs a narrower, complete preview.`)
        const ctx = this.context(preview.token)
        if (ctx.preview.items.length > remaining)
          throw new Error('Custom cleaner item limit reached. Narrow or disable some rules.')
        remaining -= ctx.preview.items.length
        if (ctx.preview.items.length)
          results.push({
            category: 'app',
            subcategory: `Custom: ${rule.name}`,
            group: 'Custom cleaners',
            items: ctx.preview.items,
            itemCount: ctx.preview.itemCount,
            totalSize: ctx.preview.totalSize
          })
      } catch (e) {
        logError(`Custom cleaner ${rule.name} skipped`, e)
      }
    }
    return results
  }
}
