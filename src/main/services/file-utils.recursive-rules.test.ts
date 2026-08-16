import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./settings-store', () => ({
  getSettings: () => ({ cleaner: { secureDelete: false, skipRecentMinutes: 60 }, exclusions: [] }),
}))

vi.mock('./scan-cache', () => ({
  getCachedItems: () => [],
  removeCachedItems: () => {},
}))

import { resolveChildSubdirs, resolveRecursivePathMatches } from './file-utils'

const tempRoots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kudu-recursive-rule-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolveRecursivePathMatches', () => {
  it('returns exact cache leaves only beneath the required anchor', async () => {
    const root = await tempRoot()
    const cache = join(root, 'App', 'EBWebView', 'Default', 'Cache')
    const codeCache = join(root, 'App', 'EBWebView', 'Default', 'Code Cache')
    const localStorage = join(root, 'App', 'EBWebView', 'Default', 'Local Storage')
    const excludedCache = join(localStorage, 'Cache')
    const unanchoredCache = join(root, 'Other', 'Default', 'Cache')
    await Promise.all([cache, codeCache, excludedCache, unanchoredCache].map((dir) => mkdir(dir, { recursive: true })))

    const resolved = await resolveRecursivePathMatches([root], {
      anchor: 'EBWebView',
      targets: ['Cache', 'Code Cache', 'GPUCache'],
      excludedAncestors: ['Local Storage'],
      maxDepth: 8,
    })

    expect(new Set(resolved)).toEqual(new Set([cache, codeCache]))
    expect(resolved).not.toContain(localStorage)
    expect(resolved).not.toContain(excludedCache)
    expect(resolved).not.toContain(unanchoredCache)
  })

  it('honours the configured maximum depth', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'one', 'two', 'EBWebView', 'Default', 'Cache'), { recursive: true })

    expect(await resolveRecursivePathMatches([root], {
      anchor: 'EBWebView',
      targets: ['Cache'],
      maxDepth: 2,
    })).toEqual([])
  })

  it('rejects directory traversal and path-shaped match names', async () => {
    const root = await tempRoot()
    expect(await resolveRecursivePathMatches([root], { anchor: '..', targets: ['Cache'] })).toEqual([])
    expect(await resolveRecursivePathMatches([root], { anchor: 'EBWebView', targets: ['Default/Cache'] })).toEqual([])
  })

  it('takes precedence over a childSubdir when resolving rule paths', async () => {
    const root = await tempRoot()
    const cache = join(root, 'EBWebView', 'Default', 'Cache')
    await mkdir(cache, { recursive: true })

    expect(await resolveChildSubdirs([root], 'unrelated', {
      anchor: 'EBWebView',
      targets: ['Cache'],
    })).toEqual([cache])
  })
})
