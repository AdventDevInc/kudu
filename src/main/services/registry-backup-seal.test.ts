import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'

const mocks = vi.hoisted(() => ({
  native: vi.fn(),
  tracked: vi.fn(),
  admin: vi.fn(() => true)
}))
vi.mock('./exec-utf8', () => ({
  execNativeUtf8: mocks.native,
  execTracked: mocks.tracked,
  psUtf8: (v: string) => v
}))
vi.mock('./elevation', () => ({ isAdmin: mocks.admin }))

import {
  createPrivateTempDir,
  readSeal,
  readSeals,
  removeSeal,
  removeSeals,
  sealBackup,
  sha256Hex,
  sweepSeals,
  verifySeal
} from './registry-backup-seal'

const KEY = 'HKLM\\SOFTWARE\\Kudu\\RegistryBackupSeals'
const NAME = 'registry-backup-targeted-2026-09-20T04-54-02-325Z.reg'
const BYTES = Buffer.from('backup bytes')
const HASH = createHash('sha256').update(BYTES).digest('hex')
const queryOutput = (rows: string[]) =>
  ['', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Kudu\\RegistryBackupSeals', ...rows, ''].join('\r\n')

const platform = process.platform
beforeEach(() => {
  vi.resetAllMocks()
  mocks.admin.mockReturnValue(true)
  mocks.native.mockResolvedValue({ stdout: '', stderr: '' })
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
})

describe('sealBackup', () => {
  it('records the SHA-256 of the exact bytes under HKLM, in the 64-bit view', async () => {
    expect(sha256Hex(BYTES)).toBe(HASH)
    await expect(sealBackup(NAME, BYTES)).resolves.toBe(true)
    expect(mocks.native).toHaveBeenCalledWith(
      'reg',
      ['add', KEY, '/v', NAME, '/t', 'REG_SZ', '/d', HASH, '/f', '/reg:64'],
      expect.anything()
    )
  })

  it('does nothing when not elevated, off Windows, or for names that are not plain file names', async () => {
    mocks.admin.mockReturnValue(false)
    expect(await sealBackup(NAME, BYTES)).toBe(false)
    mocks.admin.mockReturnValue(true)
    for (const name of ['..\\x.reg', 'a b.reg', 'sub\\x.reg', 'x.txt', 'a..reg', '"x".reg'])
      expect(await sealBackup(name, BYTES)).toBe(false)
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(await sealBackup(NAME, BYTES)).toBe(false)
    expect(mocks.native).not.toHaveBeenCalled()
  })

  it('reports failure instead of throwing when the write fails', async () => {
    mocks.native.mockRejectedValue(new Error('ERROR: Access is denied.'))
    await expect(sealBackup(NAME, BYTES)).resolves.toBe(false)
  })
})

describe('readSeal / readSeals / verifySeal', () => {
  it('reads the seal from HKLM and compares it with the bytes', async () => {
    mocks.native.mockResolvedValue({
      stdout: queryOutput([`    ${NAME}    REG_SZ    ${HASH.toUpperCase()}`]),
      stderr: ''
    })
    expect(await readSeal(NAME)).toBe(HASH)
    expect(mocks.native).toHaveBeenCalledWith(
      'reg',
      ['query', KEY, '/v', NAME, '/reg:64'],
      expect.anything()
    )
    expect(await verifySeal(NAME, BYTES)).toBe(true)
    expect(await verifySeal(NAME, Buffer.from('changed'))).toBe(false)
  })

  it('treats a missing, unreadable or malformed seal as no seal', async () => {
    mocks.native.mockRejectedValue(new Error('ERROR: The system was unable to find the value.'))
    expect(await readSeal(NAME)).toBeNull()
    expect(await verifySeal(NAME, BYTES)).toBe(false)
    mocks.native.mockResolvedValue({
      stdout: queryOutput([`    ${NAME}    REG_SZ    not-a-hash`]),
      stderr: ''
    })
    expect(await readSeal(NAME)).toBeNull()
    mocks.native.mockResolvedValue({
      stdout: queryOutput([`    ${NAME}    REG_DWORD    0x1`]),
      stderr: ''
    })
    expect(await readSeal(NAME)).toBeNull()
  })

  it('lists every seal by lower-cased name', async () => {
    const other = 'pre-restore-backup-2026-09-20T04-54-02-325Z.reg'
    mocks.native.mockResolvedValue({
      stdout: queryOutput([
        `    ${NAME.replace('registry-backup', 'Registry-Backup')}    REG_SZ    ${HASH}`,
        `    ${other}    REG_SZ    ${'0'.repeat(64)}`,
        '    junk line'
      ]),
      stderr: ''
    })
    expect(await readSeals()).toEqual(
      new Map([
        [NAME.toLowerCase(), HASH],
        [other.toLowerCase(), '0'.repeat(64)]
      ])
    )
    mocks.native.mockRejectedValue(new Error('ERROR: The system was unable to find the key.'))
    expect(await readSeals()).toEqual(new Map())
  })
})

describe('removeSeal', () => {
  it('deletes the value and never throws', async () => {
    await removeSeal(NAME)
    expect(mocks.native).toHaveBeenCalledWith(
      'reg',
      ['delete', KEY, '/v', NAME, '/f', '/reg:64'],
      expect.anything()
    )
    mocks.native.mockRejectedValue(new Error('ERROR: The system was unable to find the value.'))
    await expect(removeSeal(NAME)).resolves.toBeUndefined()
    mocks.native.mockClear()
    await removeSeal('..\\evil.reg')
    expect(mocks.native).not.toHaveBeenCalled()
  })
})

describe('removeSeals / sweepSeals', () => {
  const OTHER = 'pre-restore-backup-2026-09-20T04-54-02-325Z.reg'
  const deletes = () => mocks.native.mock.calls.filter((c) => c[1][0] === 'delete')

  it('removes only the seals that exist, reading the list once', async () => {
    mocks.native.mockImplementation(async (_tool: string, args: string[]) => ({
      stdout: args[0] === 'query' ? queryOutput([`    ${NAME}    REG_SZ    ${HASH}`]) : '',
      stderr: ''
    }))
    await removeSeals([NAME, OTHER])
    expect(mocks.native.mock.calls.filter((c) => c[1][0] === 'query')).toHaveLength(1)
    expect(deletes().map((c) => c[1][3])).toEqual([NAME])

    mocks.native.mockClear()
    mocks.admin.mockReturnValue(false)
    await removeSeals([NAME])
    expect(mocks.native).not.toHaveBeenCalled()
  })

  it('drops seals whose file is gone and returns the rest', async () => {
    const seals = new Map([
      [NAME.toLowerCase(), HASH],
      [OTHER.toLowerCase(), HASH]
    ])
    const kept = await sweepSeals(seals, new Set([NAME.toLowerCase()]))
    expect(kept).toEqual(new Map([[NAME.toLowerCase(), HASH]]))
    expect(deletes().map((c) => c[1][3])).toEqual([OTHER.toLowerCase()])

    // Unelevated: nothing can be removed, but a missing file's seal is still not returned.
    mocks.native.mockClear()
    mocks.admin.mockReturnValue(false)
    expect(await sweepSeals(seals, new Set())).toEqual(new Map())
    expect(mocks.native).not.toHaveBeenCalled()
  })
})

describe('createPrivateTempDir', () => {
  it('creates a protected folder in the Windows temp folder and returns its path', async () => {
    mocks.tracked.mockImplementation(async (_tool: string, args: string[]) => {
      const name = /'(kudu-reg-restore-[0-9a-f]{32})'/.exec(args.at(-1)!)![1]
      return { stdout: `C:\\Windows\\Temp\\${name}`, stderr: '' }
    })
    const path = await createPrivateTempDir('kudu-reg-restore-')
    expect(path).toMatch(/^C:\\Windows\\Temp\\kudu-reg-restore-[0-9a-f]{32}$/)
    const script = mocks.tracked.mock.calls[0][1].at(-1) as string
    expect(script).toContain("GetFolderPath('Windows')")
    expect(script).toContain('SetAccessRuleProtection($true,$false)')
    expect(script).toContain('CreateDirectory($p,$s)')
    // Only Administrators and SYSTEM get write access; the owner is limited to reading.
    expect(script).toContain("@('S-1-5-32-544',$full),@('S-1-5-18',$full),@('S-1-3-4',$read)")
  })

  it('refuses when not elevated, for odd prefixes, or when the result looks wrong', async () => {
    mocks.admin.mockReturnValue(false)
    await expect(createPrivateTempDir('kudu-x-')).rejects.toThrow(/administrator/)
    mocks.admin.mockReturnValue(true)
    await expect(createPrivateTempDir("x'; evil; '")).rejects.toThrow(/prefix/)
    expect(mocks.tracked).not.toHaveBeenCalled()
    mocks.tracked.mockResolvedValue({
      stdout: 'C:\\Users\\me\\AppData\\Local\\Temp\\x',
      stderr: ''
    })
    await expect(createPrivateTempDir('kudu-x-')).rejects.toThrow(/private temp folder/)
    mocks.tracked.mockRejectedValue(new Error('Temp folder grants access to S-1-5-32-545'))
    await expect(createPrivateTempDir('kudu-x-')).rejects.toThrow(/grants access/)
  })
})
