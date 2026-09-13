import type { ScanItem, CleanResult } from './types'

export interface CustomCleanerRule {
  version: 1
  id: string
  name: string
  description: string
  platform: 'win32' | 'darwin' | 'linux'
  root: string
  patterns: string[]
  excludePatterns: string[]
  excludeDirectories: string[]
  minAgeDays: number
  maxDepth: number
  enabled: boolean
}
export interface CustomCleanerPreview {
  token: string
  rule: CustomCleanerRule
  state: 'complete' | 'partial' | 'cancelled'
  visited: number
  items: ScanItem[]
  itemCount: number
  totalSize: number
  warnings: string[]
}
export interface CustomCleanerReceipt {
  ruleId: string
  ruleName: string
  startedAt: string
  finishedAt: string
  selected: number
  result: CleanResult
}
export const customRuleId = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^custom-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
export function validCustomRule(v: unknown): v is CustomCleanerRule {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as CustomCleanerRule
  if (
    Object.keys(r).some(
      (k) =>
        ![
          'version',
          'id',
          'name',
          'description',
          'platform',
          'root',
          'patterns',
          'excludePatterns',
          'excludeDirectories',
          'minAgeDays',
          'maxDepth',
          'enabled'
        ].includes(k)
    )
  )
    return false
  const str = (x: unknown, min: number, max: number): x is string =>
    typeof x === 'string' && x.length >= min && x.length <= max && !/[\u0000-\u001f]/.test(x)
  const patterns = (x: unknown, min: number): boolean =>
    Array.isArray(x) &&
    x.length >= min &&
    x.length <= 20 &&
    x.every(
      (p) => str(p, 1, 80) && !/[\\/:[\]{}]/.test(p) && !p.includes('**') && p !== '.' && p !== '..'
    )
  return (
    r.version === 1 &&
    customRuleId(r.id) &&
    str(r.name, 1, 80) &&
    str(r.description, 1, 500) &&
    ['win32', 'darwin', 'linux'].includes(r.platform) &&
    str(r.root, 1, 1024) &&
    patterns(r.patterns, 1) &&
    patterns(r.excludePatterns, 0) &&
    Array.isArray(r.excludeDirectories) &&
    r.excludeDirectories.length <= 20 &&
    r.excludeDirectories.every(
      (p) =>
        str(p, 1, 160) &&
        !p.startsWith('/') &&
        !/[\\:*?]/.test(p) &&
        p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
    ) &&
    Number.isInteger(r.minAgeDays) &&
    r.minAgeDays >= 1 &&
    r.minAgeDays <= 3650 &&
    Number.isInteger(r.maxDepth) &&
    r.maxDepth >= 0 &&
    r.maxDepth <= 8 &&
    typeof r.enabled === 'boolean'
  )
}

/** Bounded wildcard matching, without constructing a backtracking regular expression. */
export function customGlob(name: string, pattern: string, caseInsensitive: boolean): boolean {
  if (caseInsensitive) {
    name = name.toLowerCase()
    pattern = pattern.toLowerCase()
  }
  let n = 0,
    p = 0,
    star = -1,
    retry = 0
  while (n < name.length) {
    if (pattern[p] === '?' || pattern[p] === name[n]) {
      n++
      p++
    } else if (pattern[p] === '*') {
      star = p++
      retry = n
    } else if (star !== -1) {
      p = star + 1
      n = ++retry
    } else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}
