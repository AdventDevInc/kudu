import { describe, it, expect, vi } from 'vitest'

vi.mock('./elevation', () => ({ isAdmin: () => false }))

import {
  cleanOutput,
  computeSeverity,
  stripTrailingVersion,
  parseWingetUpgradeOutput,
  parseWingetListOutput,
  parseBrewOutdatedJson,
  parseBrewInstalledJson,
  parseAptUpgradable,
  parseDpkgInstalled,
  parseDnfCheckUpdate,
  parsePacmanQu,
  parseChocoOutdatedOutput,
  parseChocoListOutput,
  isValidAppId,
  BREW_PATH_CANDIDATES,
} from './software-updater'

// ─── cleanOutput ────────────────────────────────────────────

describe('cleanOutput', () => {
  it('strips ANSI escape sequences', () => {
    expect(cleanOutput('\x1B[32mhello\x1B[0m')).toBe('hello')
  })

  it('handles carriage return (spinner overwrite)', () => {
    expect(cleanOutput('loading...\rdone')).toBe('done')
  })

  it('handles \\r\\n line endings', () => {
    expect(cleanOutput('line1\r\nline2\r\n')).toBe('line1\nline2\n')
  })

  it('returns empty for empty input', () => {
    expect(cleanOutput('')).toBe('')
  })

  it('preserves normal text', () => {
    expect(cleanOutput('hello world')).toBe('hello world')
  })
})

// ─── computeSeverity ────────────────────────────────────────

describe('computeSeverity', () => {
  it('detects major version bump', () => {
    expect(computeSeverity('1.2.3', '2.0.0')).toBe('major')
  })

  it('detects minor version bump', () => {
    expect(computeSeverity('1.2.3', '1.3.0')).toBe('minor')
  })

  it('detects patch version bump', () => {
    expect(computeSeverity('1.2.3', '1.2.4')).toBe('patch')
  })

  it('returns unknown for unparseable versions', () => {
    expect(computeSeverity('latest', 'newest')).toBe('unknown')
  })

  it('returns unknown for equal versions', () => {
    expect(computeSeverity('1.2.3', '1.2.3')).toBe('unknown')
  })

  it('handles two-segment versions', () => {
    expect(computeSeverity('1.2', '1.3')).toBe('minor')
    expect(computeSeverity('1.2', '2.0')).toBe('major')
  })

  it('handles versions with extra suffixes', () => {
    // The regex stops at digits, so "1.2.3-beta" parses as 1.2.3
    expect(computeSeverity('1.2.3-beta', '2.0.0-rc1')).toBe('major')
  })
})

// ─── stripTrailingVersion ───────────────────────────────────

describe('stripTrailingVersion', () => {
  it('strips trailing version from name', () => {
    expect(stripTrailingVersion('HandBrake 1.11.0')).toBe('HandBrake')
  })

  it('strips trailing version with v prefix', () => {
    expect(stripTrailingVersion('SomeApp v2.3.1')).toBe('SomeApp')
  })

  it('leaves names without trailing version unchanged', () => {
    expect(stripTrailingVersion('Google Chrome')).toBe('Google Chrome')
  })

  it('does not strip version-like numbers in the middle', () => {
    expect(stripTrailingVersion('Driver Booster 13')).toBe('Driver Booster')
  })

  it('leaves version-only string unchanged (no name to preserve)', () => {
    expect(stripTrailingVersion('1.2.3')).toBe('1.2.3')
  })
})

// ─── parseWingetUpgradeOutput ───────────────────────────────

describe('parseWingetUpgradeOutput', () => {
  it('parses standard winget upgrade output', () => {
    const output = [
      'Name                     Id                              Version     Available   Source',
      '----------------------------------------------------------------------------------------',
      'Google Chrome            Google.Chrome                   120.0.1     121.0.0     winget',
      'Visual Studio Code       Microsoft.VisualStudioCode      1.85.0      1.86.0      winget',
      '2 upgrades available.',
    ].join('\n')

    const apps = parseWingetUpgradeOutput(output)
    expect(apps).toHaveLength(2)
    expect(apps[0].id).toBe('Google.Chrome')
    expect(apps[0].currentVersion).toBe('120.0.1')
    expect(apps[0].availableVersion).toBe('121.0.0')
    expect(apps[0].severity).toBe('major')
    expect(apps[1].id).toBe('Microsoft.VisualStudioCode')
  })

  it('returns empty for no header', () => {
    expect(parseWingetUpgradeOutput('no upgrades found')).toEqual([])
  })

  it('returns empty for empty input', () => {
    expect(parseWingetUpgradeOutput('')).toEqual([])
  })

  it('handles > prefix in versions', () => {
    const output = [
      'Name    Id           Version     Available   Source',
      '------------------------------------------------------',
      'App     Some.App     > 1.0.0     > 2.0.0     winget',
    ].join('\n')

    const apps = parseWingetUpgradeOutput(output)
    expect(apps).toHaveLength(1)
    expect(apps[0].currentVersion).toBe('1.0.0')
    expect(apps[0].availableVersion).toBe('2.0.0')
  })

  it('handles < prefix in versions', () => {
    const output = [
      'Name    Id           Version        Available      Source',
      '------------------------------------------------------------',
      'App     Some.App     < 2.0.0        3.0.0          winget',
    ].join('\n')

    const apps = parseWingetUpgradeOutput(output)
    expect(apps).toHaveLength(1)
    expect(apps[0].currentVersion).toBe('2.0.0')
    expect(apps[0].availableVersion).toBe('3.0.0')
  })

  it('skips entries where < version equals available (already up to date)', () => {
    const output = [
      'Name              Id                          Version          Available        Source',
      '-----------------------------------------------------------------------------------------',
      'Driver Booster 13 IObit.DriverBooster         < 13.2.0.184     13.2.0.184       winget',
    ].join('\n')

    const apps = parseWingetUpgradeOutput(output)
    expect(apps).toHaveLength(0)
  })

  it('strips trailing version from display names', () => {
    const output = [
      'Name                Id                     Version     Available   Source',
      '--------------------------------------------------------------------------',
      'HandBrake 1.11.0    fr.handbrake.ghb       1.11.0      1.11.1      winget',
    ].join('\n')

    const apps = parseWingetUpgradeOutput(output)
    expect(apps).toHaveLength(1)
    expect(apps[0].name).toBe('HandBrake')
    expect(apps[0].currentVersion).toBe('1.11.0')
    expect(apps[0].availableVersion).toBe('1.11.1')
  })
})

// ─── parseWingetListOutput ──────────────────────────────────

describe('parseWingetListOutput', () => {
  it('parses standard winget list output', () => {
    const output = [
      'Name              Id                    Version    Available  Source',
      '---------------------------------------------------------------------',
      'Google Chrome     Google.Chrome         121.0.0               winget',
      'Node.js           OpenJS.NodeJS         20.10.0               winget',
    ].join('\n')

    const apps = parseWingetListOutput(output)
    expect(apps).toHaveLength(2)
    expect(apps[0].id).toBe('Google.Chrome')
    expect(apps[0].version).toBe('121.0.0')
  })

  it('skips ARP entries', () => {
    const output = [
      'Name     Id              Version  Source',
      '------------------------------------------',
      'Legacy   ARP\\LegacyApp   1.0.0    ',
    ].join('\n')

    expect(parseWingetListOutput(output)).toEqual([])
  })

  it('skips Unknown versions', () => {
    const output = [
      'Name     Id          Version  Source',
      '--------------------------------------',
      'App      Some.App    Unknown  winget',
    ].join('\n')

    expect(parseWingetListOutput(output)).toEqual([])
  })
})

// ─── parseBrewOutdatedJson ──────────────────────────────────

describe('parseBrewOutdatedJson', () => {
  it('parses formulae and casks', () => {
    const json = JSON.stringify({
      formulae: [
        { name: 'curl', installed_versions: ['7.87.0'], current_version: '7.88.0' },
      ],
      casks: [
        { name: 'firefox', token: 'firefox', installed_versions: '120.0', current_version: '121.0' },
      ],
    })

    const apps = parseBrewOutdatedJson(json)
    expect(apps).toHaveLength(2)
    expect(apps[0].id).toBe('curl')
    expect(apps[0].source).toBe('brew')
    expect(apps[1].id).toBe('firefox')
  })

  it('returns empty for invalid JSON', () => {
    expect(parseBrewOutdatedJson('not json')).toEqual([])
  })

  it('handles empty formulae/casks arrays', () => {
    const json = JSON.stringify({ formulae: [], casks: [] })
    expect(parseBrewOutdatedJson(json)).toEqual([])
  })

  it('handles missing formulae/casks', () => {
    expect(parseBrewOutdatedJson('{}')).toEqual([])
  })
})

// ─── parseBrewInstalledJson ─────────────────────────────────

describe('parseBrewInstalledJson', () => {
  it('parses formulae and casks', () => {
    const json = JSON.stringify({
      formulae: [
        { name: 'curl', installed: [{ version: '7.88.0' }], versions: { stable: '7.88.0' } },
      ],
      casks: [
        { token: 'firefox', installed: '121.0', version: '121.0' },
      ],
    })

    const apps = parseBrewInstalledJson(json)
    expect(apps).toHaveLength(2)
    expect(apps[0].id).toBe('curl')
    expect(apps[0].version).toBe('7.88.0')
    expect(apps[1].id).toBe('firefox')
  })

  it('skips entries with empty version', () => {
    const json = JSON.stringify({
      formulae: [{ name: 'empty', installed: [], versions: {} }],
      casks: [],
    })
    expect(parseBrewInstalledJson(json)).toEqual([])
  })
})

// ─── BREW_PATH_CANDIDATES ───────────────────────────────────

describe('BREW_PATH_CANDIDATES', () => {
  // Regression guard for macOS GUI launches: launchd-inherited PATH does not
  // include either Homebrew install location, so both absolute paths must be
  // probed before falling back to a PATH lookup.
  it('probes both Apple Silicon and Intel brew locations', () => {
    expect(BREW_PATH_CANDIDATES).toContain('/opt/homebrew/bin/brew')
    expect(BREW_PATH_CANDIDATES).toContain('/usr/local/bin/brew')
  })

  it('prefers Apple Silicon over Intel', () => {
    const arm = BREW_PATH_CANDIDATES.indexOf('/opt/homebrew/bin/brew')
    const intel = BREW_PATH_CANDIDATES.indexOf('/usr/local/bin/brew')
    expect(arm).toBeLessThan(intel)
  })

  it('falls back to PATH lookup last', () => {
    expect(BREW_PATH_CANDIDATES[BREW_PATH_CANDIDATES.length - 1]).toBe('brew')
  })
})

// ─── parseAptUpgradable ─────────────────────────────────────

describe('parseAptUpgradable', () => {
  it('parses apt list --upgradable output', () => {
    const output = [
      'Listing... Done',
      'curl/jammy-updates 7.81.0-1ubuntu1.16 amd64 [upgradable from: 7.81.0-1ubuntu1.15]',
      'git/jammy-updates 1:2.34.1-1ubuntu1.11 amd64 [upgradable from: 1:2.34.1-1ubuntu1.10]',
    ].join('\n')

    const apps = parseAptUpgradable(output)
    expect(apps).toHaveLength(2)
    expect(apps[0].id).toBe('curl')
    expect(apps[0].availableVersion).toBe('7.81.0-1ubuntu1.16')
    expect(apps[0].currentVersion).toBe('7.81.0-1ubuntu1.15')
    expect(apps[0].source).toBe('apt')
  })

  it('skips Listing header', () => {
    expect(parseAptUpgradable('Listing... Done\n')).toEqual([])
  })

  it('returns empty for empty input', () => {
    expect(parseAptUpgradable('')).toEqual([])
  })
})

// ─── parseDpkgInstalled ─────────────────────────────────────

describe('parseDpkgInstalled', () => {
  it('parses tab-separated dpkg output', () => {
    const output = 'curl\t7.81.0-1ubuntu1.15\ngit\t1:2.34.1-1ubuntu1.10\n'
    const apps = parseDpkgInstalled(output)
    expect(apps).toHaveLength(2)
    expect(apps[0]).toEqual({ id: 'curl', name: 'curl', version: '7.81.0-1ubuntu1.15', source: 'apt' })
  })

  it('returns empty for empty input', () => {
    expect(parseDpkgInstalled('')).toEqual([])
  })
})

// ─── parseDnfCheckUpdate ────────────────────────────────────

describe('parseDnfCheckUpdate', () => {
  it('parses dnf check-update output', () => {
    const output = [
      'Last metadata expiration check: 0:30:00 ago.',
      'curl.x86_64                    7.76.1-23.el9           baseos',
      'git.x86_64                     2.43.0-1.el9            appstream',
    ].join('\n')

    const apps = parseDnfCheckUpdate(output)
    expect(apps).toHaveLength(2)
    expect(apps[0].id).toBe('curl')
    expect(apps[0].availableVersion).toBe('7.76.1-23.el9')
    expect(apps[0].source).toBe('baseos')
  })

  it('skips metadata and obsoleting lines', () => {
    const output = 'Last metadata expiration check: 0:01:00 ago.\nObsoleting Packages\n'
    expect(parseDnfCheckUpdate(output)).toEqual([])
  })

  it('returns empty for empty input', () => {
    expect(parseDnfCheckUpdate('')).toEqual([])
  })
})

// ─── parsePacmanQu ──────────────────────────────────────────

describe('parsePacmanQu', () => {
  it('parses pacman -Qu output', () => {
    const output = 'curl 7.87.0-1 -> 7.88.0-1\ngit 2.43.0-1 -> 2.44.0-1\n'
    const apps = parsePacmanQu(output)
    expect(apps).toHaveLength(2)
    expect(apps[0].id).toBe('curl')
    expect(apps[0].currentVersion).toBe('7.87.0-1')
    expect(apps[0].availableVersion).toBe('7.88.0-1')
    expect(apps[0].source).toBe('pacman')
  })

  it('returns empty for empty input', () => {
    expect(parsePacmanQu('')).toEqual([])
  })

  it('skips malformed lines', () => {
    expect(parsePacmanQu('not a valid line\n')).toEqual([])
  })
})

// ─── isValidAppId ───────────────────────────────────────────

describe('isValidAppId', () => {
  const platformId =
    process.platform === 'darwin'
      ? 'google-chrome'
      : process.platform === 'linux'
        ? 'google-chrome-stable'
        : 'Google.Chrome'

  const platformIdAlt =
    process.platform === 'darwin'
      ? 'visual-studio-code'
      : process.platform === 'linux'
        ? 'code'
        : 'Microsoft.VisualStudioCode'

  it('accepts a typical package ID', () => {
    expect(isValidAppId(platformId)).toBe(true)
  })

  it('accepts another typical package ID', () => {
    expect(isValidAppId(platformIdAlt)).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isValidAppId('')).toBe(false)
  })

  it('rejects strings starting with a dot', () => {
    expect(isValidAppId('.hidden')).toBe(false)
  })

  it('rejects very long IDs', () => {
    expect(isValidAppId('a'.repeat(300))).toBe(false)
  })
})

// ─── parseChocoOutdatedOutput ──────────────────────────────

describe('parseChocoOutdatedOutput', () => {
  it('parses standard pipe-delimited output', () => {
    const stdout = [
      'googlechrome|125.0.6422.76|126.0.6478.57|false',
      '7zip|24.06|24.07|false',
    ].join('\n')
    const apps = parseChocoOutdatedOutput(stdout)
    expect(apps).toHaveLength(2)
    expect(apps[0]).toMatchObject({
      id: 'googlechrome',
      name: 'googlechrome',
      currentVersion: '125.0.6422.76',
      availableVersion: '126.0.6478.57',
      source: 'choco',
      selected: true,
    })
    expect(apps[1]).toMatchObject({
      id: '7zip',
      currentVersion: '24.06',
      availableVersion: '24.07',
    })
  })

  it('returns empty for empty input', () => {
    expect(parseChocoOutdatedOutput('')).toEqual([])
  })

  it('skips pinned packages', () => {
    const stdout = 'firefox|130.0|131.0|true\ngooglechrome|125.0|126.0|false'
    const apps = parseChocoOutdatedOutput(stdout)
    expect(apps).toHaveLength(1)
    expect(apps[0].id).toBe('googlechrome')
  })

  it('skips lines where versions match', () => {
    const stdout = 'notepadplusplus|8.6.9|8.6.9|false'
    const apps = parseChocoOutdatedOutput(stdout)
    expect(apps).toHaveLength(0)
  })

  it('skips lines with fewer than 4 pipe-delimited fields', () => {
    const stdout = 'some random text\ngooglechrome|125.0|126.0|false'
    const apps = parseChocoOutdatedOutput(stdout)
    expect(apps).toHaveLength(1)
  })

  it('computes severity correctly', () => {
    const stdout = 'pkg|1.0.0|2.0.0|false'
    const apps = parseChocoOutdatedOutput(stdout)
    expect(apps[0].severity).toBe('major')
  })
})

// ─── parseChocoListOutput ──────────────────────────────────

describe('parseChocoListOutput', () => {
  it('parses standard pipe-delimited output', () => {
    const stdout = [
      'googlechrome|126.0.6478.57',
      '7zip|24.07',
      'firefox|131.0',
    ].join('\n')
    const apps = parseChocoListOutput(stdout)
    expect(apps).toHaveLength(3)
    expect(apps[0]).toMatchObject({
      id: 'googlechrome',
      name: 'googlechrome',
      version: '126.0.6478.57',
      source: 'choco',
    })
  })

  it('returns empty for empty input', () => {
    expect(parseChocoListOutput('')).toEqual([])
  })

  it('skips lines with fewer than 2 pipe-delimited fields', () => {
    const stdout = 'some random text\ngooglechrome|126.0'
    const apps = parseChocoListOutput(stdout)
    expect(apps).toHaveLength(1)
    expect(apps[0].id).toBe('googlechrome')
  })
})
