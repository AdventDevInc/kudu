import { describe, it, expect } from 'vitest'
import { resolvePath, buildCleanerPaths } from './loader'
import type { RulesJsonSet } from './loader'

describe('resolvePath', () => {
  const vars = { HOME: '/Users/test', APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }

  it('resolves a single variable', () => {
    expect(resolvePath('${HOME}/Downloads', vars, 'darwin')).toBe('/Users/test/Downloads')
  })

  it('resolves multiple variables', () => {
    expect(resolvePath('${HOME}/.config/${HOME}', vars, 'linux')).toBe('/Users/test/.config//Users/test')
  })

  it('converts forward slashes to backslashes on win32', () => {
    expect(resolvePath('${APPDATA}/discord/Cache', vars, 'win32')).toBe('C:\\Users\\test\\AppData\\Roaming\\discord\\Cache')
  })

  it('leaves forward slashes on non-win32', () => {
    expect(resolvePath('${HOME}/.config/Code', vars, 'linux')).toBe('/Users/test/.config/Code')
  })

  it('throws on unknown variable', () => {
    expect(() => resolvePath('${UNKNOWN}/foo', vars, 'linux')).toThrow('Unknown template variable ${UNKNOWN}')
  })

  it('passes through paths without variables', () => {
    expect(resolvePath('/tmp', vars, 'linux')).toBe('/tmp')
    expect(resolvePath('C:/Windows.old', vars, 'win32')).toBe('C:\\Windows.old')
  })

  it('does not resolve $VAR without braces', () => {
    expect(resolvePath('$HOME/path', vars, 'linux')).toBe('$HOME/path')
  })

  it('does not resolve malformed ${} syntax', () => {
    expect(() => resolvePath('${}/path', vars, 'linux')).not.toThrow()
    expect(resolvePath('${}/path', vars, 'linux')).toBe('${}/path')
  })

  it('does not recursively resolve nested variables', () => {
    const nestedVars = { HOME: '${APPDATA}', APPDATA: '/should-not-appear' }
    expect(resolvePath('${HOME}/test', nestedVars, 'linux')).toBe('${APPDATA}/test')
  })

  it('handles paths with literal dollar signs (Windows $PatchCache$)', () => {
    expect(resolvePath('${HOME}/Installer/$PatchCache$', vars, 'linux')).toBe('/Users/test/Installer/$PatchCache$')
  })

  it('resolves variables with digits like PROGRAMFILES_X86', () => {
    const win32Vars = { ...vars, PROGRAMFILES_X86: 'C:\\Program Files (x86)' }
    expect(resolvePath('${PROGRAMFILES_X86}/Steam', win32Vars, 'win32')).toBe('C:\\Program Files (x86)\\Steam')
  })
})

describe('buildCleanerPaths', () => {
  const minimalJson: RulesJsonSet = {
    system: {
      type: 'system',
      cleanTargets: [
        { path: '${HOME}/temp', subcategory: 'Temp' },
        { path: '/var/tmp', subcategory: 'System Temp', needsAdmin: true },
      ],
      singleFileTargets: [{ path: '${HOME}/dump.dmp', subcategory: 'Dump' }],
    },
    browsers: {
      type: 'browsers',
      chromiumCacheDirs: {
        profile: [
          { dir: 'Cache', label: 'Cache' },
          { dir: 'Code Cache', label: 'Code Cache' },
          { dir: 'GpuCache', label: 'GPU Cache' },
          { dir: 'Service Worker/CacheStorage', label: 'Service Worker Cache' },
        ],
        shared: [{ dir: 'GrShaderCache', label: 'Skia Shader Cache' }],
      },
      chromium: [
        { key: 'chrome', base: '${CONFIG}/google-chrome' },
      ],
      firefox: { base: '${HOME}/.mozilla/firefox', cache: '${CACHE}/mozilla/firefox' },
      safari: null,
    },
    apps: {
      type: 'apps',
      apps: [
        { id: 'discord', name: 'Discord', paths: ['${CONFIG}/discord/Cache'] },
        { id: 'jetbrains', name: 'JetBrains', paths: ['${CACHE}/JetBrains'], childSubdir: 'caches' },
        { id: 'webview', name: 'WebView', paths: ['${CACHE}'], recursiveMatch: { anchor: 'EBWebView', targets: ['Cache'], maxDepth: 8 } },
      ],
    },
    gaming: {
      type: 'gaming',
      apps: [{ id: 'steam', name: 'Steam', paths: ['${HOME}/.steam/logs'] }],
    },
    gpuCache: {
      type: 'gpu-cache',
      apps: [{ id: 'mesa-cache', name: 'Mesa', paths: ['${CACHE}/mesa'] }],
    },
    steam: {
      type: 'steam',
      libraries: ['${HOME}/.steam/steamapps'],
      redistPatterns: ['_CommonRedist', 'vcredist'],
    },
    databases: {
      type: 'databases',
      sharedDbFileSets: {
        chromium: ['History', 'Cookies', 'Network/Cookies'],
      },
      targets: [
        { label: 'Chrome', basePath: '${CONFIG}/google-chrome', dbFiles: '$chromium', multiProfile: true },
        { label: 'Discord', basePath: '${CONFIG}/discord', dbFiles: ['Network/Cookies'] },
      ],
    },
    misc: {
      type: 'misc',
      protectedEventLogs: [],
      trashPath: '${LOCAL_SHARE}/Trash/files',
    },
  }

  const paths = buildCleanerPaths(minimalJson, 'linux')

  it('resolves systemCleanTargets', () => {
    const targets = paths.systemCleanTargets()
    expect(targets).toHaveLength(2)
    expect(targets[0].path).toContain('/temp')
    expect(targets[1].needsAdmin).toBe(true)
  })

  it('resolves singleFileCleanTargets', () => {
    const targets = paths.singleFileCleanTargets()
    expect(targets).toHaveLength(1)
    expect(targets[0].subcategory).toBe('Dump')
  })

  it('resolves browserPaths with chromium cache dirs', () => {
    const bp = paths.browserPaths()
    expect(bp.chrome.profileCaches).toContainEqual({ dir: 'Cache', label: 'Cache' })
    expect(bp.chrome.sharedCaches).toEqual([{ dir: 'GrShaderCache', label: 'Skia Shader Cache' }])
    expect(bp.chrome.base).toContain('google-chrome')
    expect(bp.firefox.base).toContain('.mozilla')
    expect(bp.safari).toBeNull()
  })

  it('defaults sharedCaches to an empty list when the rules omit it', () => {
    const noShared = {
      ...minimalJson,
      browsers: {
        ...minimalJson.browsers,
        chromiumCacheDirs: { profile: [{ dir: 'Cache', label: 'Cache' }] },
      },
    }
    expect(buildCleanerPaths(noShared, 'linux').browserPaths().chrome.sharedCaches).toEqual([])
  })

  it('resolves appPaths with indirect path matchers', () => {
    const apps = paths.appPaths()
    expect(apps).toHaveLength(3)
    expect(apps[1].childSubdir).toBe('caches')
    expect(apps[2].recursiveMatch).toEqual({ anchor: 'EBWebView', targets: ['Cache'], maxDepth: 8 })
  })

  it('resolves gamingPaths', () => {
    expect(paths.gamingPaths()).toHaveLength(1)
  })

  it('resolves gpuCachePaths', () => {
    expect(paths.gpuCachePaths()).toHaveLength(1)
  })

  it('resolves steamLibraries and redistPatterns', () => {
    expect(paths.steamLibraries()).toHaveLength(1)
    expect(paths.steamRedistPatterns()).toContain('_CommonRedist')
  })

  it('resolves trashPath', () => {
    expect(paths.trashPath()).toContain('Trash/files')
  })

  it('resolves databaseOptimizeTargets with shared sets', () => {
    const targets = paths.databaseOptimizeTargets()
    expect(targets).toHaveLength(2)
    // $chromium reference should be resolved
    expect(targets[0].dbFiles).toEqual(['History', 'Cookies', 'Network/Cookies'])
    expect(targets[0].multiProfile).toBe(true)
    // inline array
    expect(targets[1].dbFiles).toEqual(['Network/Cookies'])
  })

  it('throws on unknown sharedDbFileSets reference', () => {
    const badJson = {
      ...minimalJson,
      databases: {
        type: 'databases' as const,
        sharedDbFileSets: {},
        targets: [{ label: 'Bad', basePath: '/tmp', dbFiles: '$nonexistent' }],
      },
    }
    const badPaths = buildCleanerPaths(badJson, 'linux')
    expect(() => badPaths.databaseOptimizeTargets()).toThrow("Unknown sharedDbFileSets reference '$nonexistent'")
  })
})
