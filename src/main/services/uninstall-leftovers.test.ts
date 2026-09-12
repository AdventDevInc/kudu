import { describe, it, expect } from 'vitest'

import { isSafeFolder, buildMatchTokens, matchesInstalledProgram } from './uninstall-leftovers'
describe('isSafeFolder', () => {
  it('protects Windows core folders', () => {
    expect(isSafeFolder('Microsoft')).toBe(true)
    expect(isSafeFolder('Windows')).toBe(true)
    expect(isSafeFolder('Common Files')).toBe(true)
  })

  it('protects user profile folders', () => {
    expect(isSafeFolder('Desktop')).toBe(true)
    expect(isSafeFolder('Documents')).toBe(true)
    expect(isSafeFolder('Downloads')).toBe(true)
  })

  it('protects runtime/language folders', () => {
    expect(isSafeFolder('Python')).toBe(true)
    expect(isSafeFolder('node.js')).toBe(true)
    expect(isSafeFolder('Java')).toBe(true)
    expect(isSafeFolder('Go')).toBe(true)
  })

  it('protects GPU vendor folders', () => {
    expect(isSafeFolder('NVIDIA')).toBe(true)
    expect(isSafeFolder('AMD')).toBe(true)
    expect(isSafeFolder('Intel')).toBe(true)
  })

  it('protects security software folders', () => {
    expect(isSafeFolder('Malwarebytes')).toBe(true)
    expect(isSafeFolder('CrowdStrike')).toBe(true)
    expect(isSafeFolder('Bitdefender')).toBe(true)
  })

  it('protects hidden folders (starting with dot)', () => {
    expect(isSafeFolder('.config')).toBe(true)
    expect(isSafeFolder('.local')).toBe(true)
    expect(isSafeFolder('.vscode')).toBe(true)
  })

  it('protects GUID-style folders', () => {
    expect(isSafeFolder('{12345678-1234-1234-1234-123456789abc}')).toBe(true)
  })

  it('protects prefix-matched folders', () => {
    expect(isSafeFolder('Microsoft.NET')).toBe(true)
    expect(isSafeFolder('Microsoft VisualCpp')).toBe(true)
    expect(isSafeFolder('Windows.old')).toBe(true)
    expect(isSafeFolder('Python312')).toBe(true)
    expect(isSafeFolder('jdk-21')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isSafeFolder('MICROSOFT')).toBe(true)
    expect(isSafeFolder('discord')).toBe(true)
    expect(isSafeFolder('STEAM')).toBe(true)
  })

  it('does NOT protect arbitrary unknown folders', () => {
    expect(isSafeFolder('MyOldApp')).toBe(false)
    expect(isSafeFolder('RandomSoftware2023')).toBe(false)
    expect(isSafeFolder('TotallyLegit')).toBe(false)
  })
})

// ─── buildMatchTokens / matchesInstalledProgram (replica) ────────

interface InstalledProgram {
  displayName: string
  publisher: string
  installLocation: string
}

describe('buildMatchTokens', () => {
  it('extracts display name as a token', () => {
    const tokens = buildMatchTokens([
      {
        displayName: 'Discord',
        publisher: 'Discord Inc',
        installLocation: 'C:\\Users\\Test\\AppData\\Local\\Discord'
      }
    ])
    expect(tokens.has('discord')).toBe(true)
  })

  it('extracts first word of display name', () => {
    const tokens = buildMatchTokens([
      { displayName: 'Visual Studio Code 1.85', publisher: 'Microsoft', installLocation: '' }
    ])
    expect(tokens.has('visual')).toBe(true)
  })

  it('strips trailing version numbers', () => {
    const tokens = buildMatchTokens([
      { displayName: 'Visual Studio Code 1.85', publisher: '', installLocation: '' }
    ])
    expect(tokens.has('visualstudiocode')).toBe(true)
  })

  it('extracts publisher tokens', () => {
    const tokens = buildMatchTokens([
      { displayName: 'Foo', publisher: 'Acme Corporation', installLocation: '' }
    ])
    expect(tokens.has('acmecorporation')).toBe(true)
    expect(tokens.has('acme')).toBe(true)
  })

  it('extracts install folder name', () => {
    const tokens = buildMatchTokens([
      { displayName: 'Foo', publisher: '', installLocation: 'C:\\Program Files\\SuperApp' }
    ])
    expect(tokens.has('superapp')).toBe(true)
  })
})

describe('matchesInstalledProgram', () => {
  const programs: InstalledProgram[] = [
    {
      displayName: 'Discord',
      publisher: 'Discord Inc',
      installLocation: 'C:\\Users\\Test\\AppData\\Local\\Discord'
    },
    {
      displayName: 'Visual Studio Code 1.85',
      publisher: 'Microsoft Corporation',
      installLocation: 'C:\\Program Files\\Microsoft VS Code'
    },
    {
      displayName: 'Steam',
      publisher: 'Valve Corporation',
      installLocation: 'C:\\Program Files (x86)\\Steam'
    }
  ]
  const tokens = buildMatchTokens(programs)

  it('exact matches installed program names', () => {
    expect(matchesInstalledProgram('Discord', tokens)).toBe(true)
  })

  it('matches folder name that contains a token', () => {
    expect(matchesInstalledProgram('DiscordPTB', tokens)).toBe(true)
  })

  it('matches when token is prefix of folder', () => {
    expect(matchesInstalledProgram('steamcmd', tokens)).toBe(true)
  })

  it('does NOT match short unrelated folders', () => {
    expect(matchesInstalledProgram('abc', tokens)).toBe(false)
  })

  it('does NOT match completely unrelated folders', () => {
    expect(matchesInstalledProgram('TotallyUnknownApp', tokens)).toBe(false)
  })

  it('matches publisher names', () => {
    expect(matchesInstalledProgram('Valve Corporation', tokens)).toBe(true)
  })
})
