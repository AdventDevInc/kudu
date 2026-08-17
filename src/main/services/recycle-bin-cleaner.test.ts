import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const execTracked = vi.hoisted(() => vi.fn())

vi.mock('./exec-utf8', () => ({
  execTracked,
  psUtf8: (script: string) => script,
}))

import {
  emptyRecycleBinDirectory,
  emptyRecycleBinFast,
  finalizeRecycleBinShell,
  parseRecycleBinDirectories,
} from './recycle-bin-cleaner'

describe('recycle-bin-cleaner', () => {
  let tempRoot = ''

  beforeEach(async () => {
    execTracked.mockReset()
    tempRoot = await mkdtemp(join(tmpdir(), 'kudu-recycle-clean-'))
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('accepts only exact per-user Recycle Bin directories', () => {
    const encode = (value: string) => Buffer.from(value).toString('base64')
    expect(parseRecycleBinDirectories([
      encode('C:\\$Recycle.Bin\\S-1-5-21-100-200-300-1001'),
      encode('D:\\$Recycle.Bin\\S-1-5-21-100-200-300-1001'),
      encode('C:\\Windows'),
      'not-base64!',
    ].join('\r\n'))).toEqual([
      'C:\\$Recycle.Bin\\S-1-5-21-100-200-300-1001',
      'D:\\$Recycle.Bin\\S-1-5-21-100-200-300-1001',
    ])
  })

  it('deletes payloads, paired metadata, and orphan metadata but nothing else', async () => {
    await mkdir(join(tempRoot, '$Rfolder', 'nested'), { recursive: true })
    await writeFile(join(tempRoot, '$Rfolder', 'nested', 'data.bin'), 'payload')
    await writeFile(join(tempRoot, '$Ifolder'), 'metadata')
    await writeFile(join(tempRoot, '$Rfile.txt'), 'payload')
    await writeFile(join(tempRoot, '$Ifile.txt'), 'metadata')
    await writeFile(join(tempRoot, '$Iorphan'), 'metadata')
    await writeFile(join(tempRoot, 'desktop.ini'), 'keep')

    const result = await emptyRecycleBinDirectory(tempRoot)

    expect(result).toMatchObject({
      payloadsFound: 2,
      payloadsDeleted: 2,
      payloadsFailed: 0,
      orphanMetadataDeleted: 1,
      accessDenied: false,
    })
    expect(await readdir(tempRoot)).toEqual(['desktop.ini'])
    expect(await readFile(join(tempRoot, 'desktop.ini'), 'utf-8')).toBe('keep')
  })

  it('discovers current-user directories before deleting them', async () => {
    execTracked.mockResolvedValue({ stdout: '', stderr: '' })

    await expect(emptyRecycleBinFast()).resolves.toEqual({
      payloadsFound: 0,
      payloadsDeleted: 0,
      payloadsFailed: 0,
      orphanMetadataDeleted: 0,
      accessDenied: false,
    })
    expect(execTracked).toHaveBeenCalledTimes(1)
    expect(execTracked.mock.calls[0][1].join(' ')).toContain('WindowsIdentity.GetCurrent().User.Value')
  })

  it('bounds the Windows shell finalizer', async () => {
    execTracked.mockResolvedValue({ stdout: '0\r\n', stderr: '' })

    await expect(finalizeRecycleBinShell()).resolves.toBe(0)

    expect(execTracked.mock.calls[0][1].join(' ')).toContain('SHEmptyRecycleBin')
    expect(execTracked.mock.calls[0][2]).toMatchObject({ timeout: 10_000 })
  })
})
