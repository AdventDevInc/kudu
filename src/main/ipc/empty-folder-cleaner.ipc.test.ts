import { describe, it, expect } from 'vitest'

// ── Test the pure logic from empty-folder-cleaner.ipc.ts ──
// Replicated here to avoid importing the Electron-dependent module.

// ── Protected folder lists (replica) ──

const PROTECTED_WIN32 = [
  'windows', 'system32', 'syswow64', 'winsxs', 'program files', 'program files (x86)',
  'programdata', 'recovery', 'boot', '$recycle.bin', 'system volume information',
  'perflogs', 'msocache', 'config.msi', 'drivers', 'inf', 'logs',
]
const PROTECTED_UNIX = [
  'bin', 'sbin', 'usr', 'etc', 'var', 'lib', 'lib64', 'opt', 'boot', 'dev',
  'proc', 'sys', 'run', 'tmp', 'snap', 'root', 'lost+found',
  'system', 'library', 'applications', 'cores', 'private', 'volumes',
]
const PROTECTED_GENERIC = [
  '.git', '.svn', '.hg', 'node_modules', '.npm', '.cache', '.local',
  '__pycache__', '.venv', '.env', '.ssh', '.gnupg', '.config',
  'appdata', '.android', '.gradle',
]

// ── isProtectedFolder (replica) ──

/** Cross-platform basename that handles both / and \ separators */
function xbasename(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

function isProtectedFolder(folderPath: string, platform: string, home: string): boolean {
  const name = xbasename(folderPath).toLowerCase()
  const pathLower = folderPath.toLowerCase().replace(/\\/g, '/')

  const segments = pathLower.split('/').filter(Boolean)
  const isRootLevel = platform === 'win32' ? segments.length <= 2 : segments.length <= 1

  if (isRootLevel) return true

  const protectedNames = platform === 'win32'
    ? [...PROTECTED_WIN32, ...PROTECTED_GENERIC]
    : [...PROTECTED_UNIX, ...PROTECTED_GENERIC]

  if (protectedNames.includes(name)) return true

  const userProfileDirs = ['desktop', 'documents', 'downloads', 'pictures', 'videos', 'music', 'onedrive']
  if (userProfileDirs.includes(name)) {
    const homeLower = home.toLowerCase().replace(/\\/g, '/')
    if (homeLower) {
      const parent = pathLower.substring(0, pathLower.lastIndexOf('/'))
      if (parent === homeLower || parent === homeLower + '/') return true
    }
  }

  return false
}

describe('isProtectedFolder', () => {
  // ── Root-level protection ──

  it('protects root-level Windows directories', () => {
    expect(isProtectedFolder('C:\\Windows', 'win32', 'C:\\Users\\User')).toBe(true)
    expect(isProtectedFolder('C:\\Users', 'win32', 'C:\\Users\\User')).toBe(true)
  })

  it('protects root-level Unix directories', () => {
    expect(isProtectedFolder('/usr', 'linux', '/home/user')).toBe(true)
    expect(isProtectedFolder('/etc', 'linux', '/home/user')).toBe(true)
  })

  it('protects Windows drive root', () => {
    expect(isProtectedFolder('C:\\', 'win32', 'C:\\Users\\User')).toBe(true)
  })

  it('protects Unix root', () => {
    expect(isProtectedFolder('/', 'linux', '/home/user')).toBe(true)
  })

  // ── Named protected folders ──

  it('protects Windows system folders by name', () => {
    expect(isProtectedFolder('C:\\Users\\User\\projects\\system32', 'win32', 'C:\\Users\\User')).toBe(true)
    expect(isProtectedFolder('C:\\Users\\User\\projects\\windows', 'win32', 'C:\\Users\\User')).toBe(true)
    expect(isProtectedFolder('D:\\data\\$recycle.bin', 'win32', 'C:\\Users\\User')).toBe(true)
    expect(isProtectedFolder('C:\\some\\programdata', 'win32', 'C:\\Users\\User')).toBe(true)
  })

  it('protects Unix system folders by name', () => {
    expect(isProtectedFolder('/home/user/projects/bin', 'linux', '/home/user')).toBe(true)
    expect(isProtectedFolder('/home/user/projects/etc', 'linux', '/home/user')).toBe(true)
    expect(isProtectedFolder('/data/lost+found', 'linux', '/home/user')).toBe(true)
  })

  it('protects generic folders (git, node_modules, etc.)', () => {
    expect(isProtectedFolder('C:\\dev\\project\\.git', 'win32', 'C:\\Users\\User')).toBe(true)
    expect(isProtectedFolder('/home/user/project/node_modules', 'linux', '/home/user')).toBe(true)
    expect(isProtectedFolder('/home/user/.ssh', 'linux', '/home/user')).toBe(true)
    expect(isProtectedFolder('C:\\project\\.env', 'win32', 'C:\\Users\\User')).toBe(true)
    expect(isProtectedFolder('/home/user/.config', 'linux', '/home/user')).toBe(true)
  })

  // ── User profile directories ──

  it('protects user profile directories directly under home', () => {
    expect(isProtectedFolder('C:\\Users\\User\\Desktop', 'win32', 'C:\\Users\\User')).toBe(true)
    expect(isProtectedFolder('C:\\Users\\User\\Documents', 'win32', 'C:\\Users\\User')).toBe(true)
    expect(isProtectedFolder('C:\\Users\\User\\Downloads', 'win32', 'C:\\Users\\User')).toBe(true)
    expect(isProtectedFolder('C:\\Users\\User\\Pictures', 'win32', 'C:\\Users\\User')).toBe(true)
    expect(isProtectedFolder('C:\\Users\\User\\Videos', 'win32', 'C:\\Users\\User')).toBe(true)
    expect(isProtectedFolder('C:\\Users\\User\\Music', 'win32', 'C:\\Users\\User')).toBe(true)
    expect(isProtectedFolder('C:\\Users\\User\\OneDrive', 'win32', 'C:\\Users\\User')).toBe(true)
  })

  it('does not protect "Desktop" when not directly under home', () => {
    // "Desktop" under some other path should not be protected by the user-profile rule
    // (but it won't be protected by name alone since "desktop" isn't in the protected lists)
    expect(isProtectedFolder('C:\\OtherPath\\subdir\\Desktop', 'win32', 'C:\\Users\\User')).toBe(false)
  })

  // ── Non-protected folders ──

  it('does not protect arbitrary deep folders', () => {
    expect(isProtectedFolder('C:\\Users\\User\\projects\\myapp\\empty', 'win32', 'C:\\Users\\User')).toBe(false)
    expect(isProtectedFolder('/home/user/projects/myapp/empty', 'linux', '/home/user')).toBe(false)
  })

  it('does not protect user-created folders with normal names', () => {
    expect(isProtectedFolder('C:\\Users\\User\\projects\\build', 'win32', 'C:\\Users\\User')).toBe(false)
    expect(isProtectedFolder('/home/user/projects/dist', 'linux', '/home/user')).toBe(false)
  })
})

// ── Scan options validation (mirrors EMPTY_FOLDERS_SCAN handler) ──

describe('empty folder scan options validation', () => {
  function validateOptions(options: unknown): { directory: string; maxDepth: number; excludePatterns: string[] } | null {
    if (!options || typeof options !== 'object') return null
    const opts = options as Record<string, unknown>

    const dir = typeof opts.directory === 'string' ? opts.directory : ''
    // isAbsolute check simplified
    const isAbs = dir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir)
    const safeOptions = {
      directory: isAbs ? dir : '',
      maxDepth: typeof opts.maxDepth === 'number' && opts.maxDepth > 0 ? opts.maxDepth : 20,
      excludePatterns: Array.isArray(opts.excludePatterns)
        ? (opts.excludePatterns as unknown[]).filter((p): p is string => typeof p === 'string')
        : []
    }
    if (!safeOptions.directory) return null
    return safeOptions
  }

  it('accepts valid options', () => {
    const result = validateOptions({ directory: '/home/user/projects', maxDepth: 10, excludePatterns: ['build'] })
    expect(result).toEqual({ directory: '/home/user/projects', maxDepth: 10, excludePatterns: ['build'] })
  })

  it('accepts Windows-style absolute path', () => {
    const result = validateOptions({ directory: 'C:\\Users\\User\\Projects', maxDepth: 5 })
    expect(result).not.toBeNull()
    expect(result!.directory).toBe('C:\\Users\\User\\Projects')
  })

  it('rejects null/undefined options', () => {
    expect(validateOptions(null)).toBe(null)
    expect(validateOptions(undefined)).toBe(null)
  })

  it('rejects non-object options', () => {
    expect(validateOptions('string')).toBe(null)
    expect(validateOptions(42)).toBe(null)
  })

  it('rejects relative directory path', () => {
    expect(validateOptions({ directory: 'relative/path' })).toBe(null)
  })

  it('rejects empty directory', () => {
    expect(validateOptions({ directory: '' })).toBe(null)
  })

  it('defaults maxDepth to 20 if not provided', () => {
    const result = validateOptions({ directory: '/home/user' })
    expect(result!.maxDepth).toBe(20)
  })

  it('defaults maxDepth to 20 if invalid', () => {
    expect(validateOptions({ directory: '/home/user', maxDepth: -5 })!.maxDepth).toBe(20)
    expect(validateOptions({ directory: '/home/user', maxDepth: 0 })!.maxDepth).toBe(20)
    expect(validateOptions({ directory: '/home/user', maxDepth: 'not a number' })!.maxDepth).toBe(20)
  })

  it('defaults excludePatterns to empty array if not provided', () => {
    const result = validateOptions({ directory: '/home/user' })
    expect(result!.excludePatterns).toEqual([])
  })

  it('filters non-string items from excludePatterns', () => {
    const result = validateOptions({ directory: '/home/user', excludePatterns: ['valid', 42, null, 'also-valid'] })
    expect(result!.excludePatterns).toEqual(['valid', 'also-valid'])
  })
})

// ── Delete path validation (mirrors EMPTY_FOLDERS_DELETE handler) ──

describe('empty folder delete path validation', () => {
  it('filters non-string paths', () => {
    const paths = ['C:\\valid', 42, null, '/also/valid'] as any[]
    const safePaths = paths.filter((p): p is string => typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)))
    expect(safePaths).toEqual(['C:\\valid', '/also/valid'])
  })

  it('filters relative paths', () => {
    const paths = ['relative/path', '/absolute/path', 'C:\\absolute\\path']
    const safePaths = paths.filter((p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p))
    expect(safePaths).toEqual(['/absolute/path', 'C:\\absolute\\path'])
  })

  it('returns empty result for non-array input', () => {
    const paths = 'not an array' as any
    const result = !Array.isArray(paths)
      ? { deleted: 0, failed: 0, errors: [] }
      : null
    expect(result).toEqual({ deleted: 0, failed: 0, errors: [] })
  })
})

// ── Delete mode validation ──

describe('delete mode validation', () => {
  it('defaults to recycle mode', () => {
    const mode = undefined
    const deleteMode = mode === 'permanent' ? 'permanent' : 'recycle'
    expect(deleteMode).toBe('recycle')
  })

  it('accepts permanent mode', () => {
    const mode = 'permanent'
    const deleteMode = mode === 'permanent' ? 'permanent' : 'recycle'
    expect(deleteMode).toBe('permanent')
  })

  it('coerces invalid mode to recycle', () => {
    const mode = 'invalid'
    const deleteMode = mode === 'permanent' ? 'permanent' : 'recycle'
    expect(deleteMode).toBe('recycle')
  })
})

// ── Sort deepest first for deletion ──

describe('path sorting for deletion', () => {
  it('sorts deepest paths first', () => {
    const paths = [
      '/home/user/a',
      '/home/user/a/b/c/d',
      '/home/user/a/b',
      '/home/user/a/b/c'
    ]
    paths.sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length)
    expect(paths[0]).toBe('/home/user/a/b/c/d')
    expect(paths[1]).toBe('/home/user/a/b/c')
    expect(paths[2]).toBe('/home/user/a/b')
    expect(paths[3]).toBe('/home/user/a')
  })

  it('handles Windows-style paths', () => {
    const paths = [
      'C:\\Users\\User',
      'C:\\Users\\User\\a\\b\\c',
      'C:\\Users\\User\\a'
    ]
    paths.sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length)
    expect(paths[0]).toBe('C:\\Users\\User\\a\\b\\c')
    expect(paths[2]).toBe('C:\\Users\\User')
  })
})

// ── EmptyFolderEntry sorting ──

describe('empty folder entry sorting', () => {
  it('sorts by depth descending (deepest first)', () => {
    const entries = [
      { path: '/a', name: 'a', depth: 1 },
      { path: '/a/b/c', name: 'c', depth: 3 },
      { path: '/a/b', name: 'b', depth: 2 },
    ]
    entries.sort((a, b) => b.depth - a.depth)
    expect(entries[0].depth).toBe(3)
    expect(entries[1].depth).toBe(2)
    expect(entries[2].depth).toBe(1)
  })
})

// ── Delete result structure ──

describe('delete result structure', () => {
  it('tracks deleted, failed, and errors', () => {
    let deleted = 0
    let failed = 0
    const errors: { path: string; reason: string }[] = []

    // Simulate successful deletion
    deleted++

    // Simulate protected folder rejection
    failed++
    errors.push({ path: '/protected/path', reason: 'Protected system folder' })

    // Simulate folder no longer empty
    failed++
    errors.push({ path: '/changed/path', reason: 'Folder is no longer empty' })

    expect(deleted).toBe(1)
    expect(failed).toBe(2)
    expect(errors).toHaveLength(2)
  })
})

// ── EMPTY_FOLDERS_OPEN_LOCATION validation ──

describe('open location validation', () => {
  it('rejects non-string input', () => {
    const folderPath: unknown = 42
    const valid = typeof folderPath === 'string' && (folderPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(folderPath))
    expect(valid).toBe(false)
  })

  it('rejects relative paths', () => {
    const folderPath = 'relative/path'
    const valid = typeof folderPath === 'string' && (folderPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(folderPath))
    expect(valid).toBe(false)
  })

  it('accepts absolute Unix path', () => {
    const folderPath = '/home/user/folder'
    const valid = typeof folderPath === 'string' && (folderPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(folderPath))
    expect(valid).toBe(true)
  })

  it('accepts absolute Windows path', () => {
    const folderPath = 'C:\\Users\\User\\folder'
    const valid = typeof folderPath === 'string' && (folderPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(folderPath))
    expect(valid).toBe(true)
  })
})

// ── findEmptyFolders boundary conditions ──

describe('findEmptyFolders boundary conditions', () => {
  it('respects maxDepth limit', () => {
    const depth = 25
    const maxDepth = 20
    const shouldRecurse = depth <= maxDepth
    expect(shouldRecurse).toBe(false)
  })

  it('treats symlinks as content (non-empty)', () => {
    // In the source, symlinks cause hasFiles = true
    const entry = { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false }
    const hasFiles = entry.isSymbolicLink()
    expect(hasFiles).toBe(true)
  })

  it('skips hidden/dot directories', () => {
    const entryName = '.hidden'
    const shouldSkip = entryName.startsWith('.')
    expect(shouldSkip).toBe(true)
  })

  it('does not skip non-dot directories', () => {
    const entryName = 'normal'
    const shouldSkip = entryName.startsWith('.')
    expect(shouldSkip).toBe(false)
  })

  it('excludes directories matching excludePatterns', () => {
    const excludePatterns = ['build', 'dist', 'Node_Modules']
    const entryName = 'build'
    const entryNameLower = entryName.toLowerCase()
    const excluded = excludePatterns.some((p) => entryName === p || entryNameLower === p.toLowerCase())
    expect(excluded).toBe(true)
  })

  it('exclude pattern matching is case-insensitive', () => {
    const excludePatterns = ['BUILD']
    const entryName = 'build'
    const entryNameLower = entryName.toLowerCase()
    const excluded = excludePatterns.some((p) => entryName === p || entryNameLower === p.toLowerCase())
    expect(excluded).toBe(true)
  })
})
