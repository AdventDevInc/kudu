import { describe, it, expect } from 'vitest'
import { parseWinReInfo } from './winre-status'

const ENABLED = `
Windows Recovery Environment (Windows RE) and system reset configuration
Information:

    Windows RE status:         Enabled
    Windows RE location:       \\\\?\\GLOBALROOT\\device\\harddisk0\\partition4\\Recovery\\WindowsRE
    Boot Configuration Data (BCD) identifier: 12345678-1234-1234-1234-123456789abc
    Recovery image location:
    Recovery image index:      0
    Custom image location:
    Custom image index:        0

REAGENTC.EXE: Operation Successful.
`.trim()

const DISABLED = `
Windows Recovery Environment (Windows RE) and system reset configuration
Information:

    Windows RE status:         Disabled
    Windows RE location:
    Boot Configuration Data (BCD) identifier: 00000000-0000-0000-0000-000000000000
    Recovery image location:
    Recovery image index:      0
    Custom image location:
    Custom image index:        0

REAGENTC.EXE: Operation Successful.
`.trim()

describe('parseWinReInfo', () => {
  it('parses Enabled status and location', () => {
    expect(parseWinReInfo(ENABLED)).toEqual({
      status: 'Enabled',
      location: '\\\\?\\GLOBALROOT\\device\\harddisk0\\partition4\\Recovery\\WindowsRE',
      bcdIdentifier: '12345678-1234-1234-1234-123456789abc',
    })
  })

  it('parses Disabled status with empty location', () => {
    expect(parseWinReInfo(DISABLED)).toEqual({
      status: 'Disabled',
      location: null,
      bcdIdentifier: '00000000-0000-0000-0000-000000000000',
    })
  })

  it('returns Unknown with a reason when the status line is absent', () => {
    // Non-elevated shells get an access-denied line; localised Windows prints
    // a translated label. Neither means WinRE is missing.
    const info = parseWinReInfo('REAGENTC.EXE: Operation Successful.')
    expect(info.status).toBe('Unknown')
    expect(info.location).toBeNull()
    expect(info.bcdIdentifier).toBeNull()
    expect(info.error).toMatch(/elevated/i)
  })

  it('treats unrecognised status text as Unknown', () => {
    expect(parseWinReInfo('Windows RE status:         Weird').status).toBe('Unknown')
  })
})
