import { describe, it, expect } from 'vitest'

// ─── registeredCommandMatches (replica of src/main/index.ts) ─────
// index.ts boots the Electron app on import, so the pure helper is replicated
// here — same convention as malware-scanner.test.ts.
//
// Why this check exists: the task XML is written to %LOCALAPPDATA%\Temp, which
// any process running as this user can write, including a non-elevated one.
// schtasks reads it back elevated and the task carries RunLevel
// HighestAvailable, so a swap between our write and its read would register an
// attacker's command as a logon-triggered admin task. After registering we ask
// Task Scheduler what it actually stored and compare it against our exe.

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function registeredCommandMatches(taskXml: string, exePath: string): boolean {
  const commands = [...taskXml.matchAll(/<Command>([\s\S]*?)<\/Command>/gi)]
    .map((m) => m[1].trim().replace(/^"|"$/g, ''))
    .filter((c) => c.length > 0)
  if (commands.length === 0) return false
  const expected = exePath.trim().toLowerCase()
  return commands.every((c) => decodeXmlEntities(c).toLowerCase() === expected)
}

const EXE = 'C:\\Program Files\\Kudu\\Kudu.exe'

function taskXml(...commands: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2">',
    '  <Actions Context="Author">',
    ...commands.map((c) => `    <Exec><Command>${c}</Command><Arguments>--startup</Arguments></Exec>`),
    '  </Actions>',
    '</Task>',
  ].join('\r\n')
}

describe('registeredCommandMatches', () => {
  it('accepts the task we meant to register', () => {
    expect(registeredCommandMatches(taskXml(EXE), EXE)).toBe(true)
  })

  it('accepts a command Task Scheduler echoed back quoted', () => {
    expect(registeredCommandMatches(taskXml(`"${EXE}"`), EXE)).toBe(true)
  })

  it('accepts a path whose ampersand came back XML-escaped', () => {
    const exe = 'C:\\Tools\\R&D\\Kudu.exe'
    expect(registeredCommandMatches(taskXml('C:\\Tools\\R&amp;D\\Kudu.exe'), exe)).toBe(true)
  })

  it('ignores case, which Windows paths do', () => {
    expect(registeredCommandMatches(taskXml(EXE.toUpperCase()), EXE)).toBe(true)
  })

  it('tolerates surrounding whitespace', () => {
    expect(registeredCommandMatches(taskXml(`\r\n      ${EXE}\r\n    `), EXE)).toBe(true)
  })

  it('rejects a substituted command', () => {
    expect(registeredCommandMatches(taskXml('C:\\attacker\\backdoor.exe'), EXE)).toBe(false)
  })

  it('rejects a payload appended after a legitimate entry', () => {
    // Checking only the first <Command> would pass this — an injected XML can
    // declare more than one Exec action and Task Scheduler runs them all.
    expect(registeredCommandMatches(taskXml(EXE, 'C:\\attacker\\backdoor.exe'), EXE)).toBe(false)
  })

  it('rejects a payload placed before the legitimate entry', () => {
    expect(registeredCommandMatches(taskXml('C:\\attacker\\backdoor.exe', EXE), EXE)).toBe(false)
  })

  it('rejects a definition with no command at all', () => {
    expect(registeredCommandMatches('<Task version="1.2"><Actions /></Task>', EXE)).toBe(false)
  })

  it('rejects empty output, so a failed query is not read as success', () => {
    expect(registeredCommandMatches('', EXE)).toBe(false)
  })

  it('rejects a command that merely starts with our path', () => {
    expect(registeredCommandMatches(taskXml(EXE + '.evil.exe'), EXE)).toBe(false)
  })
})
