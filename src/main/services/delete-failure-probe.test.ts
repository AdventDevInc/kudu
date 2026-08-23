import { describe, expect, it } from 'vitest'
import { parseWindowsDeleteProbe } from './delete-failure-probe'

describe('parseWindowsDeleteProbe', () => {
  it('separates ACL failures from sharing violations', () => {
    const result = parseWindowsDeleteProbe(JSON.stringify([
      { path: 'C:\\Windows\\Logs\\CBS.log', code: 5 },
      { path: 'C:\\Users\\User\\AppData\\Local\\Temp\\busy.tmp', code: 32 },
      { path: 'C:\\cache\\race.tmp', code: 33 },
      { path: 'C:\\cache\\deletable.tmp', code: 0 },
    ]))

    expect(result.get('c:\\windows\\logs\\cbs.log')).toBe('permission-denied')
    expect(result.get('c:\\users\\user\\appdata\\local\\temp\\busy.tmp')).toBe('in-use')
    expect(result.get('c:\\cache\\race.tmp')).toBe('in-use')
    expect(result.has('c:\\cache\\deletable.tmp')).toBe(false)
  })

  it('returns no classifications for malformed output', () => {
    expect(parseWindowsDeleteProbe('not-json').size).toBe(0)
  })
})
