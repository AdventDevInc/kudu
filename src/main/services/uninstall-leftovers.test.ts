import { describe, it, expect } from 'vitest'

// We test the pure functions replicated from uninstall-leftovers.ts since they
// are not exported. These are safety-critical — they decide what gets flagged
// for deletion vs what is protected.

import { SAFE_FOLDER_NAMES, SAFE_PREFIXES } from '../constants/uninstall-safelist'

// ─── isSafeFolder (replica) ──────────────────────────────────────

function isSafeFolder(folderName: string): boolean {
  const lower = folderName.toLowerCase()
  if (SAFE_FOLDER_NAMES.has(lower)) return true
  for (const prefix of SAFE_PREFIXES) {
    if (lower.startsWith(prefix)) return true
  }
  if (lower.startsWith('.')) return true
  if (/^\{[0-9a-f-]+\}$/i.test(folderName)) return true
  return false
}

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

function buildMatchTokens(programs: InstalledProgram[]): Set<string> {
  const tokens = new Set<string>()
  for (const prog of programs) {
    const name = prog.displayName.toLowerCase().trim()
    if (name.length >= 2) {
      tokens.add(name)
      const firstWord = name.split(/[\s\-_.()]+/)[0]
      if (firstWord && firstWord.length >= 3) tokens.add(firstWord)
      const withoutVersion = name.replace(/\s+[\d.]+\s*$/, '').trim()
      if (withoutVersion.length >= 3 && withoutVersion !== name) tokens.add(withoutVersion)
    }
    const publisher = prog.publisher.toLowerCase().trim()
    if (publisher.length >= 3) {
      tokens.add(publisher)
      const pubFirst = publisher.split(/[\s\-_.()]+/)[0]
      if (pubFirst && pubFirst.length >= 3) tokens.add(pubFirst)
    }
    if (prog.installLocation) {
      const folder = prog.installLocation.split(/[/\\]/).pop()?.toLowerCase() || ''
      if (folder.length >= 2) tokens.add(folder)
    }
  }
  return tokens
}

function matchesInstalledProgram(folderName: string, tokens: Set<string>): boolean {
  const lower = folderName.toLowerCase()
  if (tokens.has(lower)) return true
  for (const token of tokens) {
    if (token.length >= 4 && lower.length >= 4) {
      if (token.includes(lower) || lower.includes(token)) return true
    }
    if (token.length >= 4) {
      if (lower.startsWith(token) || lower.endsWith(token)) return true
    }
    if (lower.length >= 4) {
      if (token.startsWith(lower) || token.endsWith(lower)) return true
    }
  }
  return false
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
    expect(tokens.has('visual studio code')).toBe(true)
  })

  it('extracts publisher tokens', () => {
    const tokens = buildMatchTokens([
      { displayName: 'Foo', publisher: 'Acme Corporation', installLocation: '' }
    ])
    expect(tokens.has('acme corporation')).toBe(true)
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
