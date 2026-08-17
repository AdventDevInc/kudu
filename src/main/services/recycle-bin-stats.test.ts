import { beforeEach, describe, expect, it, vi } from 'vitest'

const execTracked = vi.hoisted(() => vi.fn())

vi.mock('./exec-utf8', () => ({
  execTracked,
  psUtf8: (script: string) => script,
}))

import { parseRecycleBinStats, queryRecycleBinStats } from './recycle-bin-stats'

describe('parseRecycleBinStats', () => {
  it('parses count and total bytes', () => {
    expect(parseRecycleBinStats('5000|10737418240\r\n')).toEqual({
      count: 5000,
      size: 10737418240,
    })
  })

  it('normalizes missing, malformed, and negative values to zero', () => {
    expect(parseRecycleBinStats('')).toEqual({ count: 0, size: 0 })
    expect(parseRecycleBinStats('nope|-1')).toEqual({ count: 0, size: 0 })
  })
})

describe('queryRecycleBinStats', () => {
  beforeEach(() => execTracked.mockReset())

  it('reads recycle-bin entries without recursively walking payloads', async () => {
    execTracked.mockResolvedValue({ stdout: '42|1048576\r\n', stderr: '' })

    await expect(queryRecycleBinStats()).resolves.toEqual({ count: 42, size: 1048576 })

    expect(execTracked).toHaveBeenCalledTimes(1)
    const [file, args, options] = execTracked.mock.calls[0]
    expect(file).toBe('powershell.exe')
    expect(args.join(' ')).toContain('Directory.EnumerateFiles')
    expect(args.join(' ')).toContain('$I*')
    expect(args.join(' ')).toContain('Directory.Exists(payload)')
    expect(args.join(' ')).toContain('Directory.EnumerateFileSystemEntries')
    expect(args.join(' ')).toContain('$R*')
    expect(args.join(' ')).not.toContain('SearchOption.AllDirectories')
    expect(args.join(' ')).not.toContain('Measure-Object')
    expect(options).toMatchObject({ windowsHide: true, timeout: 15_000 })
  })
})
