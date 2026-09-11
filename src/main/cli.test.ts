import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseCliArgs, ExitCode, cliLog, cliVerbose, exitCodeForCleanResult, exitCodeForRestorePoint, exitCodeForRegistryFix } from './cli'

describe('parseCliArgs', () => {
  it('requires a separate explicit opt-in for performance cache resets', () => {
    const normal = parseCliArgs(['node', 'kudu', '--cli', 'scan', '--clean', '--include-maintenance'])
    expect(normal.ctx.includeCacheResets).toBeUndefined()
    const reset = parseCliArgs(['node', 'kudu', '--cli', '--include-cache-resets', 'scan', '--clean'])
    expect(reset.ctx.includeCacheResets).toBe(true)
    expect(reset.command).toBe('scan')
    expect(reset.commandArgs).not.toContain('--include-cache-resets')
  })
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

describe('JSON stdout purity', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function captureStreams(): { out: string[]; err: string[] } {
    const out: string[] = []
    const err: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      out.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      err.push(String(chunk))
      return true
    })
    return { out, err }
  }

  it('cliLog writes progress to stderr in JSON mode, keeping stdout parseable', () => {
    const { out, err } = captureStreams()
    cliLog({ json: true, verbosity: 'normal' }, 'Loading installed programs...')
    expect(out).toEqual([])
    expect(err).toEqual(['Loading installed programs...\n'])
  })

  it('cliLog writes to stdout in human mode', () => {
    const { out, err } = captureStreams()
    cliLog({ json: false, verbosity: 'normal' }, 'Scanning network...')
    expect(out).toEqual(['Scanning network...\n'])
    expect(err).toEqual([])
  })

  it('cliLog stays silent in quiet mode regardless of json', () => {
    const { out, err } = captureStreams()
    cliLog({ json: true, verbosity: 'quiet' }, 'noise')
    cliLog({ json: false, verbosity: 'quiet' }, 'noise')
    expect(out).toEqual([])
    expect(err).toEqual([])
  })

  it('cliVerbose writes to stderr in JSON mode', () => {
    const { out, err } = captureStreams()
    cliVerbose({ json: true, verbosity: 'verbose' }, 'took 12ms')
    expect(out).toEqual([])
    expect(err).toEqual(['  [verbose] took 12ms\n'])
  })

  it('cliVerbose writes to stdout in human mode', () => {
    const { out, err } = captureStreams()
    cliVerbose({ json: false, verbosity: 'verbose' }, 'took 12ms')
    expect(out).toEqual(['  [verbose] took 12ms\n'])
    expect(err).toEqual([])
  })
})

describe('exitCodeForCleanResult', () => {
  it('succeeds when nothing failed', () => {
    expect(exitCodeForCleanResult({ filesDeleted: 12, errors: [] })).toBe(ExitCode.SUCCESS)
  })

  it('reports a partial success when some files were deleted and some failed', () => {
    expect(exitCodeForCleanResult({ filesDeleted: 1833, errors: [{ path: 'a', reason: 'in-use' }] }))
      .toBe(ExitCode.PARTIAL_SUCCESS)
  })

  it('fails outright when every item was rejected', () => {
    // The shape `leftovers clean` returns today: 44 found, 44 rejected, and it
    // still exited 0 before this graded the result.
    const allRejected = Array.from({ length: 44 }, () => ({ reason: 'scan-result-expired' }))
    expect(exitCodeForCleanResult({ filesDeleted: 0, errors: allRejected }))
      .toBe(ExitCode.GENERAL_ERROR)
  })

  it('prefers the elevation code over the others', () => {
    expect(exitCodeForCleanResult({ filesDeleted: 5, errors: [{}], needsElevation: true }))
      .toBe(ExitCode.PERMISSION_DENIED)
  })
})

describe('exitCodeForRestorePoint', () => {
  it('succeeds when the restore point was created', () => {
    expect(exitCodeForRestorePoint({ success: true })).toBe(ExitCode.SUCCESS)
  })

  it('fails when System Restore is switched off', () => {
    expect(exitCodeForRestorePoint({
      success: false,
      error: 'Cannot start the service because it is disabled'
    })).toBe(ExitCode.GENERAL_ERROR)
  })

  it('reports missing elevation separately', () => {
    expect(exitCodeForRestorePoint({
      success: false,
      error: 'Administrator privileges required to create a restore point.'
    })).toBe(ExitCode.PERMISSION_DENIED)
  })

  it('still fails when no error text came back', () => {
    expect(exitCodeForRestorePoint({ success: false })).toBe(ExitCode.GENERAL_ERROR)
  })
})

describe('exitCodeForRegistryFix', () => {
  it('succeeds when every entry was fixed', () => {
    expect(exitCodeForRegistryFix({ fixed: 640, failed: 0 })).toBe(ExitCode.SUCCESS)
  })

  it('reports a partial success when one entry resisted', () => {
    expect(exitCodeForRegistryFix({ fixed: 639, failed: 1 })).toBe(ExitCode.PARTIAL_SUCCESS)
  })

  it('fails when nothing could be fixed', () => {
    expect(exitCodeForRegistryFix({ fixed: 0, failed: 7 })).toBe(ExitCode.GENERAL_ERROR)
  })
})
