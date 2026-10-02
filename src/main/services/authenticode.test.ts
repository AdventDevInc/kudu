import { describe, expect, it } from 'vitest'
import { parseAuthenticodeResults } from './authenticode'

const HASH = 'a'.repeat(64)

describe('parseAuthenticodeResults', () => {
  it('keeps only paths whose signature status is Valid, with their content hash', () => {
    const stdout = JSON.stringify([
      { path: 'C:\\Program Files (x86)\\PrivaZer\\PrivaZer.exe', status: 'Valid', sha256: HASH },
      { path: 'C:\\Users\\Test\\Downloads\\dropper.exe', status: 'NotSigned', sha256: HASH },
      { path: 'C:\\Users\\Test\\Downloads\\tampered.exe', status: 'HashMismatch', sha256: HASH },
      { path: 'C:\\Users\\Test\\Downloads\\revoked.exe', status: 'NotTrusted', sha256: HASH },
      { path: 'C:\\Users\\Test\\Downloads\\unreadable.exe', status: 'UnknownError', sha256: '' }
    ])
    expect(parseAuthenticodeResults(stdout)).toEqual(
      new Map([['c:\\program files (x86)\\privazer\\privazer.exe', HASH]])
    )
  })

  it('accepts the single object PowerShell emits for one path', () => {
    const stdout =
      '\uFEFF' +
      JSON.stringify({ path: 'C:\\App\\App.exe', status: 'Valid', sha256: HASH }) +
      '\r\n'
    expect(parseAuthenticodeResults(stdout)).toEqual(new Map([['c:\\app\\app.exe', HASH]]))
  })

  it('rejects a Valid status without a well-formed content hash', () => {
    const stdout = JSON.stringify([
      { path: 'C:\\A.exe', status: 'Valid' },
      { path: 'C:\\B.exe', status: 'Valid', sha256: '' },
      { path: 'C:\\C.exe', status: 'Valid', sha256: 'not-a-hash' }
    ])
    expect(parseAuthenticodeResults(stdout)).toEqual(new Map())
  })

  it('fails closed on malformed output', () => {
    expect(parseAuthenticodeResults('')).toEqual(new Map())
    expect(parseAuthenticodeResults('Get-AuthenticodeSignature : access denied')).toEqual(new Map())
    expect(parseAuthenticodeResults('[null, 1, {"path": 2, "status": "Valid"}]')).toEqual(new Map())
  })
})
