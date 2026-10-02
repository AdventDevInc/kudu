import { describe, expect, it } from 'vitest'
import { parseAuthenticodeResults } from './authenticode'

describe('parseAuthenticodeResults', () => {
  it('keeps only paths whose signature status is Valid', () => {
    const stdout = JSON.stringify([
      { path: 'C:\\Program Files (x86)\\PrivaZer\\PrivaZer.exe', status: 'Valid' },
      { path: 'C:\\Users\\Test\\Downloads\\dropper.exe', status: 'NotSigned' },
      { path: 'C:\\Users\\Test\\Downloads\\tampered.exe', status: 'HashMismatch' },
      { path: 'C:\\Users\\Test\\Downloads\\revoked.exe', status: 'NotTrusted' },
      { path: 'C:\\Users\\Test\\Downloads\\unreadable.exe', status: 'UnknownError' }
    ])
    expect(parseAuthenticodeResults(stdout)).toEqual(
      new Set(['c:\\program files (x86)\\privazer\\privazer.exe'])
    )
  })

  it('accepts the single object PowerShell emits for one path', () => {
    const stdout = '\uFEFF' + JSON.stringify({ path: 'C:\\App\\App.exe', status: 'Valid' }) + '\r\n'
    expect(parseAuthenticodeResults(stdout)).toEqual(new Set(['c:\\app\\app.exe']))
  })

  it('fails closed on malformed output', () => {
    expect(parseAuthenticodeResults('')).toEqual(new Set())
    expect(parseAuthenticodeResults('Get-AuthenticodeSignature : access denied')).toEqual(new Set())
    expect(parseAuthenticodeResults('[null, 1, {"path": 2, "status": "Valid"}]')).toEqual(new Set())
  })
})
