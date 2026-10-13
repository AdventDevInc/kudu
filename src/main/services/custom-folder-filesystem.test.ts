import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'fs/promises'
import { execTracked } from './exec-utf8'
import {
  assertLocalCustomFilesystem,
  onLocalLinuxFilesystem,
  onLocalMacFilesystem
} from './custom-folder-filesystem'

vi.mock('fs/promises', () => ({ readFile: vi.fn() }))
vi.mock('./exec-utf8', () => ({ execTracked: vi.fn(), psUtf8: (command: string) => command }))

const mount = (path: string, type: string, source = '/dev/sda1') =>
  `20 1 8:1 / ${path} rw - ${type} ${source} rw`
describe('Custom folder filesystem locality', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('checks the containing Linux filesystem, including a network target root', () => {
    for (const type of [
      'nfs',
      'nfs4',
      'cifs',
      'smb3',
      'fuse.sshfs',
      'fuse.s3fs',
      '9p',
      'unknown'
    ]) {
      const table = [mount('/', 'ext4'), mount('/mnt/share', type, 'server:/share')].join('\n')
      expect(onLocalLinuxFilesystem('/mnt/share', table)).toBe(false)
      expect(onLocalLinuxFilesystem('/mnt/share/cache', table)).toBe(false)
      expect(onLocalLinuxFilesystem('/mnt/shared-cache', table)).toBe(true)
    }
  })

  it('supports specific folders on local volumes, escaped mount names and block-backed FUSE', () => {
    const table = [
      mount('/', 'overlay', 'overlay'),
      mount('/media/My\\040Disk', 'exfat'),
      mount('/mnt/ntfs', 'fuseblk', '/dev/sdb1')
    ].join('\n')
    expect(onLocalLinuxFilesystem('/tmp/example/cache', table)).toBe(true)
    expect(onLocalLinuxFilesystem('/media/My Disk/app/cache', table)).toBe(true)
    expect(onLocalLinuxFilesystem('/mnt/ntfs/app/cache', table)).toBe(true)
    expect(
      onLocalLinuxFilesystem('/mnt/ntfs/cache', mount('/mnt/ntfs', 'fuseblk', 'server:/share'))
    ).toBe(false)
  })

  it('rejects missing, malformed and ambiguous Linux mount metadata', () => {
    expect(onLocalLinuxFilesystem('/cache', '')).toBe(false)
    expect(onLocalLinuxFilesystem('/cache', 'malformed')).toBe(false)
    expect(
      onLocalLinuxFilesystem(
        '/mnt/share/cache',
        [mount('/', 'ext4'), mount('/mnt/share', 'ext4'), mount('/mnt/share', 'nfs')].join('\n')
      )
    ).toBe(false)
  })

  it('uses macOS local mount flags instead of assuming /Volumes is local', () => {
    const table =
      '/dev/disk3s1 on / (apfs, local, journaled)\n//user@server/share on /Volumes/Share (smbfs, nodev, nosuid)\n/dev/disk4s1 on /Volumes/USB Disk (exfat, local, nodev)'
    expect(onLocalMacFilesystem('/Users/alex/cache', table)).toBe(true)
    expect(onLocalMacFilesystem('/Volumes/Share', table)).toBe(false)
    expect(onLocalMacFilesystem('/Volumes/Share/cache', table)).toBe(false)
    expect(onLocalMacFilesystem('/Volumes/USB Disk/cache', table)).toBe(true)
    expect(onLocalMacFilesystem('/cache', '')).toBe(false)
    expect(onLocalMacFilesystem('/cache', 'remote on / (osxfuse, local)')).toBe(false)
  })

  it('rejects mapped Windows network drives and unknown types', async () => {
    for (const type of ['4', '0', '1', '5', '', 'unexpected']) {
      vi.mocked(execTracked).mockResolvedValue({ stdout: type, stderr: '' })
      await expect(assertLocalCustomFilesystem('Q:\\cache', 'win32')).rejects.toThrow(
        'verified local'
      )
    }
    for (const type of ['2', '3', '6']) {
      vi.mocked(execTracked).mockResolvedValue({ stdout: type + '\r\n', stderr: '' })
      await expect(
        assertLocalCustomFilesystem('Q:/portable/cache', 'win32')
      ).resolves.toBeUndefined()
    }
    expect(vi.mocked(execTracked).mock.calls.at(-1)?.[1].at(-1)).toContain("'Q:\\'")
  })

  it('does not interpolate folder text into PowerShell and rejects unqualified drives', async () => {
    vi.mocked(execTracked).mockResolvedValue({ stdout: '3', stderr: '' })
    await assertLocalCustomFilesystem("Q:/app's cache; Invoke-Something", 'win32')
    expect(vi.mocked(execTracked).mock.calls[0][1].at(-1)).not.toContain('Invoke-Something')
    await expect(assertLocalCustomFilesystem('/cache', 'win32')).rejects.toThrow('drive-qualified')
  })

  it('fails closed when metadata cannot be read and refreshes it each operation', async () => {
    vi.mocked(readFile).mockResolvedValue(mount('/', 'ext4'))
    await expect(assertLocalCustomFilesystem('/mnt/share/cache', 'linux')).resolves.toBeUndefined()
    vi.mocked(readFile).mockResolvedValue(
      [mount('/', 'ext4'), mount('/mnt/share', 'nfs')].join('\n')
    )
    await expect(assertLocalCustomFilesystem('/mnt/share/cache', 'linux')).rejects.toThrow(
      'verified local'
    )
    vi.mocked(readFile).mockRejectedValue(new Error('Unavailable'))
    await expect(assertLocalCustomFilesystem('/cache', 'linux')).rejects.toThrow('Unavailable')
    vi.mocked(execTracked).mockRejectedValue(new Error('Unavailable'))
    await expect(assertLocalCustomFilesystem('Q:/cache', 'win32')).rejects.toThrow('Unavailable')
    await expect(assertLocalCustomFilesystem('/cache', 'darwin')).rejects.toThrow('Unavailable')
  })
})
