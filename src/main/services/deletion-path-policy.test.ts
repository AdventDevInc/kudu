import { describe, expect, it } from 'vitest'
import { isDeletionRoot } from './deletion-path-policy'

describe('deletion root protection', () => {
  it.each([
    '',
    '.',
    'relative',
    'D:',
    'D:folder',
    'D:\\',
    'D:/',
    'D:\\folder\\..',
    '/',
    '/tmp/..',
    '\\\\server\\share',
    '//server/share/',
    '\\\\?\\D:\\'
  ])('blocks %s', (path) => {
    expect(isDeletionRoot(path)).toBe(true)
  })
  it.each(['D:\\Apps\\Example', '/tmp/example', '\\\\server\\share\\cache'])(
    'allows a child path %s',
    (path) => {
      expect(isDeletionRoot(path)).toBe(false)
    }
  )
})
