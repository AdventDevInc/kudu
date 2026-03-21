import { describe, it, expect } from 'vitest'
import { parseCliArgs, ExitCode } from './cli'

describe('parseCliArgs', () => {
  it('parses --json flag', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli', '--json', 'registry', 'scan'])
    expect(result.ctx.json).toBe(true)
    expect(result.command).toBe('registry')
  })

  it('parses --verbose flag', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli', '--verbose', 'scan'])
    expect(result.ctx.verbosity).toBe('verbose')
  })

  it('parses --quiet flag', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli', '--quiet', 'scan'])
    expect(result.ctx.verbosity).toBe('quiet')
  })

  it('parses -q as quiet', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli', '-q', 'scan'])
    expect(result.ctx.verbosity).toBe('quiet')
  })

  it('defaults to normal verbosity', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli', 'scan'])
    expect(result.ctx.verbosity).toBe('normal')
  })

  it('parses --help flag', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli', '--help'])
    expect(result.help).toBe(true)
  })

  it('parses -h flag', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli', '-h'])
    expect(result.help).toBe(true)
  })

  it('parses --version flag', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli', '--version'])
    expect(result.version).toBe(true)
  })

  it('parses -v flag', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli', '-v'])
    expect(result.version).toBe(true)
  })

  it('extracts command correctly', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli', 'malware', 'scan', '--json'])
    expect(result.command).toBe('malware')
    expect(result.ctx.json).toBe(true)
  })

  it('filters global flags from commandArgs', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli', '--json', '--verbose', 'debloat', 'remove', '--all'])
    expect(result.commandArgs).toContain('remove')
    expect(result.commandArgs).toContain('--all')
    expect(result.commandArgs).not.toContain('--json')
    expect(result.commandArgs).not.toContain('--verbose')
  })

  it('detects legacy flags', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli', '--system', '--browser'])
    expect(result.hasLegacyFlags).toBe(true)
    expect(result.command).toBeUndefined()
  })

  it('detects --all as legacy flag', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli', '--all'])
    expect(result.hasLegacyFlags).toBe(true)
  })

  it('detects --clean flag', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli', '--all', '--clean'])
    expect(result.hasCleanFlag).toBe(true)
  })

  it('handles no arguments after --cli', () => {
    const result = parseCliArgs(['node', 'kudu', '--cli'])
    expect(result.command).toBeUndefined()
    expect(result.ctx.json).toBe(false)
    expect(result.ctx.verbosity).toBe('normal')
  })
})

describe('ExitCode', () => {
  it('has expected values', () => {
    expect(ExitCode.SUCCESS).toBe(0)
    expect(ExitCode.GENERAL_ERROR).toBe(1)
    expect(ExitCode.INVALID_ARGS).toBe(2)
    expect(ExitCode.PERMISSION_DENIED).toBe(3)
    expect(ExitCode.PARTIAL_SUCCESS).toBe(4)
    expect(ExitCode.NOTHING_FOUND).toBe(5)
    expect(ExitCode.UNKNOWN_COMMAND).toBe(6)
    expect(ExitCode.SCAN_THREATS).toBe(7)
  })

  it('all values are unique', () => {
    const values = Object.values(ExitCode)
    expect(new Set(values).size).toBe(values.length)
  })

  it('all values are under 128', () => {
    for (const code of Object.values(ExitCode)) {
      expect(code).toBeLessThan(128)
    }
  })
})
