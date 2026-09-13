import path from 'path'
import { lstat, realpath } from 'fs/promises'
import type { Stats } from 'fs'
import type { CustomCleanerRule } from '../../shared/custom-cleaners'
import { customGlob } from '../../shared/custom-cleaners'

export interface CustomRootPolicy {
  platform: 'win32' | 'darwin' | 'linux'
  home: string
  userData: string
  protectedRoots: string[]
}
const forbiddenNames = new Set([
  '.git',
  '.svn',
  '.hg',
  '.ssh',
  '.gnupg',
  '.env',
  '.aws',
  '.azure',
  '.kube',
  'keychains',
  'credentials',
  '$recycle.bin',
  'system volume information'
])
export const customProtectedName = (name: string): boolean => forbiddenNames.has(name.toLowerCase())
export function customRootAllowed(root: string, policy: CustomRootPolicy): boolean {
  const p = policy.platform === 'win32' ? path.win32 : path.posix
  const norm = (s: string) => {
    const n = p.resolve(s)
    return policy.platform === 'win32' ? n.toLowerCase() : n
  }
  const target = norm(root)
  if (
    !p.isAbsolute(root) ||
    (policy.platform === 'win32' &&
      (!/^[a-z]:[\\/]/i.test(root) || /[<>|?*]/.test(root) || root.slice(2).includes(':')))
  )
    return false
  const within = (base: string): boolean => {
    const rel = p.relative(norm(base), target)
    return rel === '' || (!rel.startsWith('..' + p.sep) && rel !== '..' && !p.isAbsolute(rel))
  }
  if (target === norm(p.parse(root).root) || p.dirname(target) === p.parse(target).root)
    return false
  if (target === norm(policy.home) || p.dirname(target) === norm(policy.home)) return false
  if (within(policy.userData) || policy.protectedRoots.some(within)) return false
  const pieces = target.split(p.sep).map((s) => s.toLowerCase())
  if (policy.platform === 'win32') {
    if (
      [
        'windows',
        'program files',
        'program files (x86)',
        'programdata',
        'recovery',
        'boot'
      ].includes(pieces[1])
    )
      return false
    if (pieces[1] === 'users' && pieces.length <= 4) return false
  } else if (/^\/(?:home|Users)\/[^/]+(?:\/[^/]+)?$/.test(target)) return false
  if (pieces.some((s) => forbiddenNames.has(s))) return false
  if (
    policy.platform === 'win32' &&
    ['appdata', 'local', 'locallow', 'roaming'].includes(p.basename(target).toLowerCase()) &&
    within(policy.home)
  )
    return false
  return true
}
export async function customRoot(
  root: string,
  policy: CustomRootPolicy
): Promise<{ path: string; info: Stats }> {
  if (!customRootAllowed(root, policy))
    throw new Error(
      'Choose a specific data/cache subfolder outside protected system, profile and Kudu folders.'
    )
  const canonical = await realpath(root)
  const equal =
    policy.platform === 'win32'
      ? canonical.toLowerCase() === path.resolve(root).toLowerCase()
      : canonical === path.resolve(root)
  if (!equal || !customRootAllowed(canonical, policy))
    throw new Error('Folder aliases and junctions are not supported. Choose the real folder.')
  for (let parent = canonical; ; parent = path.dirname(parent)) {
    const info = await lstat(parent)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Folder ancestors must be real directories')
    if (path.dirname(parent) === parent) break
  }
  return { path: canonical, info: await lstat(canonical) }
}
export function customFileMatches(
  file: string,
  rule: CustomCleanerRule,
  info: Stats,
  cutoff: number
): boolean {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.mtimeMs > cutoff ||
    !Number.isFinite(info.mtimeMs)
  )
    return false
  const relative = path.relative(rule.root, file)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  )
    return false
  const segments = relative.split(path.sep)
  if (
    segments.length - 1 > rule.maxDepth ||
    segments.some((s) => forbiddenNames.has(s.toLowerCase()))
  )
    return false
  const caseInsensitive = rule.platform === 'win32'
  const rel = caseInsensitive ? relative.replace(/\\/g, '/').toLowerCase() : relative
  if (
    rule.excludeDirectories.some((d) => {
      const x = caseInsensitive ? d.toLowerCase() : d
      return rel === x || rel.startsWith(x + '/')
    })
  )
    return false
  const name = path.basename(file)
  return (
    rule.patterns.some((p) => customGlob(name, p, caseInsensitive)) &&
    !rule.excludePatterns.some((p) => customGlob(name, p, caseInsensitive))
  )
}
export function sameCustomFile(a: Stats, b: Stats): boolean {
  return (
    b.isFile() &&
    !b.isSymbolicLink() &&
    b.nlink === 1 &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  )
}
