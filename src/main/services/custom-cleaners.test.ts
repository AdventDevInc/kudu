import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  utimes,
  rm,
  rename,
  symlink,
  link,
  realpath
} from 'fs/promises'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { CustomCleaners } from './custom-cleaners'
import { CustomCleanerStore } from './custom-cleaner-store'
import { customRootAllowed, customFileMatches } from './custom-cleaner-safety'
import { customGlob, validCustomRule } from '../../shared/custom-cleaners'
import type { CustomCleanerRule } from '../../shared/custom-cleaners'
import type { Stats } from 'fs'
import { cleanItems, safeDelete } from './file-utils'
import { clearCache } from './scan-cache'

const settings = vi.hoisted(() => ({
  cleaner: { secureDelete: false, skipRecentMinutes: 60, keepDeletionLog: false },
  exclusions: [] as string[]
}))
// Simulates Linux bind mounts (same device as the root) on every platform.
const mounts = vi.hoisted(() => new Set<string>())
vi.mock('./mount-points', () => ({
  mountPoints: async () => mounts,
  isMountPoint: async (path: string) => mounts.has(path)
}))
vi.mock('./settings-store', () => ({ getSettings: () => settings }))
vi.mock('./logger', () => ({ logInfo: () => {}, logError: () => {} }))
vi.mock('./deletion-log-store', () => ({ recordDeletions: () => {} }))
let dir: string,
  root: string,
  store: CustomCleanerStore,
  service: CustomCleaners,
  rule: CustomCleanerRule
beforeEach(async () => {
  clearCache()
  mounts.clear()
  settings.exclusions = []
  settings.cleaner.secureDelete = false
  // macOS /var is itself a symlink, which customRoot rejects.
  dir = await mkdtemp(join(await realpath(tmpdir()), 'kudu-custom-test-'))
  root = join(dir, 'cache')
  await mkdir(root)
  store = new CustomCleanerStore(join(dir, 'definitions.json'))
  service = new CustomCleaners(
    store,
    {
      platform: process.platform as 'win32' | 'linux' | 'darwin',
      home: join(dir, 'home'),
      userData: join(dir, 'kudu'),
      protectedRoots: []
    },
    () => settings.exclusions,
    () => settings.cleaner.skipRecentMinutes
  )
  rule = {
    version: 1,
    id: `custom-${randomUUID()}`,
    name: 'Test cache',
    description: 'Temporary test files only',
    root,
    platform: process.platform as 'win32' | 'linux' | 'darwin',
    patterns: ['*.tmp'],
    excludePatterns: ['keep*'],
    excludeDirectories: ['excluded'],
    minAgeDays: 7,
    maxDepth: 2,
    enabled: true
  }
})
afterEach(async () => {
  clearCache()
  await rm(dir, { recursive: true, force: true })
})
async function old(file: string): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, 'test data')
  const date = new Date(Date.now() - 86400000 * 30)
  await utimes(file, date, date)
}

describe('restricted rule definitions', () => {
  it('rejects executable extensions traversal malformed globs and unsafe bounds', () => {
    expect(validCustomRule(rule)).toBe(true)
    for (const value of [
      { ...rule, command: 'rm -rf /' },
      { ...rule, id: 'bundled-rule' },
      { ...rule, patterns: ['**/*.tmp'] },
      { ...rule, excludeDirectories: ['../outside'] },
      { ...rule, maxDepth: 9 },
      { ...rule, minAgeDays: 0 }
    ])
      expect(validCustomRule(value)).toBe(false)
    expect(customGlob('cache-01.tmp', 'cache-??.tmp', false)).toBe(true)
    expect(customGlob('CACHE.TMP', '*.tmp', false)).toBe(false)
    expect(customGlob('CACHE.TMP', '*.tmp', true)).toBe(true)
    expect(customGlob('a'.repeat(255) + 'b', '*a'.repeat(35) + 'c', false)).toBe(false)
  })
  it('blocks Windows system and profile roots, UNC aliases and credential folders', () => {
    const policy = {
      platform: 'win32' as const,
      home: 'C:\\Users\\test',
      userData: 'C:\\Users\\test\\AppData\\Roaming\\Kudu',
      protectedRoots: ['C:\\Windows', 'C:\\Program Files']
    }
    for (const path of [
      'C:\\',
      'C:\\Users',
      'C:\\Users\\test',
      'C:\\Users\\test\\Downloads',
      'C:\\Windows\\Temp',
      'C:\\Program Files\\app\\cache',
      'C:\\Users\\test\\.ssh\\cache',
      'C:\\Users\\test\\AppData\\Roaming\\Kudu\\data',
      '\\\\server\\share\\cache',
      'C:relative\\folder'
    ])
      expect(customRootAllowed(path, policy)).toBe(false)
    expect(customRootAllowed('C:\\Users\\test\\Downloads\\cache', policy)).toBe(true)
    expect(customRootAllowed('C:\\Users\\test\\AppData\\Local\\app\\cache', policy)).toBe(true)
  })
  it('blocks Unix protected subtrees and leaves specific user cache folders available', () => {
    const policy = {
      platform: 'linux' as const,
      home: '/home/test',
      userData: '/home/test/.config/kudu',
      protectedRoots: ['/etc', '/usr', '/var']
    }
    for (const path of [
      '/',
      '/etc/app/cache',
      '/home/test',
      '/home/test/Documents',
      '/home/test/.ssh/keys',
      '/home/test/.config/kudu/cache'
    ])
      expect(customRootAllowed(path, policy)).toBe(false)
    expect(customRootAllowed('/home/test/.cache/app', policy)).toBe(true)
  })
  it('matches names case-insensitively on macOS as well as Windows so exclusions cannot fail open', () => {
    const stats = {
      isFile: () => true,
      isSymbolicLink: () => false,
      nlink: 1,
      mtimeMs: 1
    } as unknown as Stats
    const base = { ...rule, patterns: ['*.log'], excludePatterns: ['Keep*'] }
    const file = (r: CustomCleanerRule, name: string) => join(r.root, name)
    const mac = { ...base, platform: 'darwin' as const }
    expect(customFileMatches(file(mac, 'keep.log'), mac, stats, 2)).toBe(false)
    expect(customFileMatches(file(mac, 'other.LOG'), mac, stats, 2)).toBe(true)
    expect(customFileMatches(join(mac.root, 'Excluded', 'x.log'), mac, stats, 2)).toBe(false)
    const linux = { ...base, platform: 'linux' as const }
    expect(customFileMatches(file(linux, 'keep.log'), linux, stats, 2)).toBe(true)
    expect(customFileMatches(file(linux, 'other.LOG'), linux, stats, 2)).toBe(false)
  })
  it('imports inert copies with fresh IDs and round-trips semantics', async () => {
    await store.update(() => [rule])
    const exported = JSON.stringify({ version: 1, rules: await store.list() })
    expect(await service.import(exported)).toBe(1)
    const copy = (await store.list())[1]
    expect(copy.id).not.toBe(rule.id)
    expect(copy.enabled).toBe(false)
    expect({ ...copy, id: rule.id, enabled: true }).toEqual(rule)
    await expect(
      service.import(JSON.stringify({ version: 1, rules: [{ ...rule, script: 'bad' }] }))
    ).rejects.toThrow('Unsupported')
    expect(await store.list()).toHaveLength(2)
  })
  it('serializes writes, preserves corrupt files, and never silently replaces a definition', async () => {
    const copies = Array.from({ length: 20 }, () => ({ ...rule, id: `custom-${randomUUID()}` }))
    await Promise.all(copies.map((r) => store.update((rows) => [...rows, r])))
    expect(await store.list()).toHaveLength(20)
    await expect(store.update((rows) => [...rows, rule])).rejects.toThrow('20-rule')
    await writeFile(join(dir, 'definitions.json'), 'corrupt')
    await expect(store.update(() => [])).rejects.toThrow()
    expect(await readFile(join(dir, 'definitions.json'), 'utf8')).toBe('corrupt')
  })
  it('drops invalid, duplicate and excess entries on read without rewriting until the next save', async () => {
    const extra = Array.from({ length: 20 }, () => ({ ...rule, id: `custom-${randomUUID()}` }))
    const raw = JSON.stringify({
      version: 1,
      rules: [rule, { ...rule, maxDepth: 99 }, rule, { ...rule, script: 'rm' }, ...extra]
    })
    await writeFile(join(dir, 'definitions.json'), raw)
    const listed = await store.list()
    expect(listed).toHaveLength(20)
    expect(listed[0]).toEqual(rule)
    expect(new Set(listed.map((r) => r.id)).size).toBe(20)
    expect(await readFile(join(dir, 'definitions.json'), 'utf8')).toBe(raw)
    await service.remove(rule.id)
    expect(await store.list()).toHaveLength(19)
    expect(JSON.parse(await readFile(join(dir, 'definitions.json'), 'utf8')).rules).toHaveLength(19)
  })
})

describe('preview and deletion safety', () => {
  it('previews only old matching single-link files within the depth and exclusions', async () => {
    await old(join(root, 'old.tmp'))
    await old(join(root, 'keep.tmp'))
    await old(join(root, 'other.log'))
    await old(join(root, 'excluded', 'old.tmp'))
    await old(join(root, 'sub', 'old.tmp'))
    await old(join(root, 'sub', 'deep', 'too', 'old.tmp'))
    await old(join(root, '.git', 'old.tmp'))
    await writeFile(join(root, 'recent.tmp'), 'new')
    await old(join(root, 'global.tmp'))
    settings.exclusions = [join(root, 'global.tmp')]
    const p = await service.preview(rule)
    expect(p.state).toBe('complete')
    expect(p.items.map((i) => i.path).sort()).toEqual(
      [join(root, 'old.tmp'), join(root, 'sub', 'old.tmp')].sort()
    )
    expect(p.totalSize).toBe(18)
    expect(await readFile(join(root, 'old.tmp'), 'utf8')).toBe('test data')
  })
  it('preview IDs cannot bypass save/enable through another cleaner entry point', async () => {
    await old(join(root, 'old.tmp'))
    const p = await service.preview(rule)
    const denied = await cleanItems(p.items.map((i) => i.id))
    expect(denied.filesDeleted).toBe(0)
    expect(denied.filesSkipped).toBe(1)
    expect(await readFile(join(root, 'old.tmp'), 'utf8')).toBe('test data')
  })
  it('runs enabled rules through the common cleanup engine and returns honest counts', async () => {
    await old(join(root, 'old.tmp'))
    await old(join(root, 'changed.tmp'))
    const p = await service.preview(rule)
    await service.save(p.token)
    await writeFile(join(root, 'changed.tmp'), 'updated since preview')
    const result = await service.clean(p.token)
    expect(result.selected).toBe(2)
    expect(result.result.filesDeleted).toBe(1)
    expect(result.result.filesSkipped).toBe(1)
    expect(result.result.totalCleaned).toBe(9)
    await expect(readFile(join(root, 'old.tmp'))).rejects.toThrow()
    expect(await readFile(join(root, 'changed.tmp'), 'utf8')).toBe('updated since preview')
  })
  it('rechecks current exclusions and disabled or edited rules before mutation', async () => {
    await old(join(root, 'old.tmp'))
    const p = await service.preview(rule)
    await service.save(p.token)
    settings.exclusions = [join(root, 'old.tmp')]
    expect((await service.clean(p.token)).result.filesDeleted).toBe(0)
    settings.exclusions = []
    const next = await service.preview(rule)
    await service.disable(rule.id)
    expect((await cleanItems(next.items.map((i) => i.id))).filesDeleted).toBe(0)
    const edited = await service.preview(rule)
    await service.save(edited.token)
    await store.update((rows) => rows.map((r) => ({ ...r, patterns: ['*.log'] })))
    expect((await cleanItems(edited.items.map((i) => i.id))).filesDeleted).toBe(0)
  })
  it('never recursively removes a replacement directory even through file-only safeDelete', async () => {
    await old(join(root, 'old.tmp'))
    const p = await service.preview(rule)
    await service.save(p.token)
    await rm(join(root, 'old.tmp'))
    await mkdir(join(root, 'old.tmp'))
    await writeFile(join(root, 'old.tmp', 'keep'), 'important')
    expect((await service.clean(p.token)).result.filesDeleted).toBe(0)
    settings.cleaner.secureDelete = true
    expect((await safeDelete(join(root, 'old.tmp'), true)).success).toBe(false)
    expect(await readFile(join(root, 'old.tmp', 'keep'), 'utf8')).toBe('important')
  })
  it('does not follow junctions or accept ancestor replacement', async () => {
    const outside = join(dir, 'outside')
    await old(join(outside, 'outside.tmp'))
    await symlink(outside, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    const p = await service.preview(rule)
    expect(p.items).toHaveLength(0)
    await expect(service.preview({ ...rule, root: join(root, 'alias') })).rejects.toThrow()
    await mkdir(join(outside, 'sub'))
    await expect(service.preview({ ...rule, root: join(root, 'alias', 'sub') })).rejects.toThrow(
      'aliases'
    )
    await old(join(root, 'sub', 'old.tmp'))
    const next = await service.preview(rule)
    await service.save(next.token)
    await rename(join(root, 'sub'), join(root, 'moved'))
    await symlink(outside, join(root, 'sub'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await service.clean(next.token)).result.filesDeleted).toBe(0)
    expect(await readFile(join(outside, 'outside.tmp'), 'utf8')).toBe('test data')
  })
  it('refuses bind-mounted folders as roots, in previews and when mounted after preview', async () => {
    await old(join(root, 'old.tmp'))
    await old(join(root, 'mounted', 'old.tmp'))
    mounts.add(join(root, 'mounted'))
    const p = await service.preview(rule)
    expect(p.state).toBe('complete')
    expect(p.items.map((i) => i.path)).toEqual([join(root, 'old.tmp')])
    expect(p.warnings).toContain('Aliases and other mounted volumes were skipped.')
    await expect(service.preview({ ...rule, root: join(root, 'mounted') })).rejects.toThrow(
      'mounted volume'
    )
    mounts.clear()
    const next = await service.preview(rule)
    expect(next.items).toHaveLength(2)
    await service.save(next.token)
    mounts.add(join(root, 'mounted'))
    const result = await service.clean(next.token)
    expect(result.result.filesDeleted).toBe(1)
    expect(result.result.filesSkipped).toBe(1)
    expect(await readFile(join(root, 'mounted', 'old.tmp'), 'utf8')).toBe('test data')
  })
  it('skips files which acquired another hard link after preview', async () => {
    await old(join(root, 'old.tmp'))
    const p = await service.preview(rule)
    await service.save(p.token)
    await link(join(root, 'old.tmp'), join(dir, 'retained.tmp'))
    expect((await service.clean(p.token)).result.filesDeleted).toBe(0)
    expect(await readFile(join(dir, 'retained.tmp'), 'utf8')).toBe('test data')
  })
  it('bounds previews, yields to cancellation, and refuses partial saves', async () => {
    await Promise.all(Array.from({ length: 150 }, (_, i) => old(join(root, `${i}.tmp`))))
    const partial = await service.preview(rule, Date.now() - 1)
    expect(partial.state).toBe('partial')
    await expect(service.save(partial.token)).rejects.toThrow('Complete')
    const pending = service.preview(rule)
    const timer = setInterval(() => service.cancel(), 1)
    const cancelled = await pending
    clearInterval(timer)
    expect(cancelled.state).toBe('cancelled')
    await expect(service.clean(cancelled.token)).rejects.toThrow('Complete')
  })
  it('paginates a preview and includes enabled definitions in normal App scans', async () => {
    await Promise.all(Array.from({ length: 110 }, (_, i) => old(join(root, `${i}.tmp`))))
    const p = await service.preview(rule)
    expect(p.itemCount).toBe(110)
    expect(p.items).toHaveLength(100)
    expect(service.page(p.token, 100)).toHaveLength(10)
    await service.save(p.token)
    const scans = await service.appScans()
    expect(scans[0].items).toHaveLength(110)
    expect(scans[0].group).toBe('Custom cleaners')
    expect(scans[0].items.every((i) => basename(i.path).endsWith('.tmp'))).toBe(true)
  })
  it('skips failing custom rules in App scans instead of failing the whole category', async () => {
    await old(join(root, 'old.tmp'))
    const missing = {
      ...rule,
      id: `custom-${randomUUID()}`,
      name: 'Missing',
      root: join(dir, 'gone')
    }
    const partial = { ...rule, id: `custom-${randomUUID()}`, name: 'Partial' }
    await store.update(() => [missing, partial, rule])
    const original = service.preview.bind(service)
    vi.spyOn(service, 'preview').mockImplementation(async (value, deadline) => {
      const p = await original(value, deadline)
      if ((value as CustomCleanerRule).name === 'Partial') p.state = 'partial'
      return p
    })
    const scans = await service.appScans()
    expect(scans.map((s) => s.subcategory)).toEqual(['Custom: Test cache'])
    expect(scans[0].items).toHaveLength(1)
    vi.restoreAllMocks()
    await rm(join(dir, 'definitions.json'))
    await mkdir(join(dir, 'definitions.json'))
    expect(await service.appScans()).toEqual([])
  })
})
