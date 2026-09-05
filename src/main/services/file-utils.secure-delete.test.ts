import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, lstat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./settings-store', () => ({ getSettings: () => ({ cleaner: { secureDelete: true }, exclusions: [] }) }))
vi.mock('./scan-cache', () => ({ getCachedItems: () => [], removeCachedItems: () => {} }))
vi.mock('./deletion-log-store', () => ({ recordDeletions: () => {} }))
import { safeDelete } from './file-utils'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kudu-secure-'))
  roots.push(root)
  const cache = join(root, 'cache')
  const outside = join(root, 'outside')
  await mkdir(cache)
  await mkdir(outside)
  const keep = join(outside, 'keep.txt')
  await writeFile(keep, 'preserve')
  return { root, cache, outside, keep }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('secure deletion link boundaries', () => {
  it('preserves files behind a nested directory junction', async () => {
    const { cache, outside, keep } = await fixture()
    await symlink(outside, join(cache, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(cache, 'ordinary'), 'junk')
    expect((await safeDelete(cache)).success).toBe(true)
    expect(await readFile(keep, 'utf8')).toBe('preserve')
    await expect(lstat(cache)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('unlinks a selected junction without overwriting its target', async () => {
    const { cache, outside, keep } = await fixture()
    const alias = join(cache, 'linked')
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect((await safeDelete(alias)).success).toBe(true)
    expect(await readFile(keep, 'utf8')).toBe('preserve')
  })
  it('unlinks a hard-linked cache file without corrupting the other name', async () => {
    const { cache, keep } = await fixture()
    const alias = join(cache, 'shared')
    await link(keep, alias)
    expect((await safeDelete(cache)).success).toBe(true)
    expect(await readFile(keep, 'utf8')).toBe('preserve')
  })
  it('still deletes ordinary files', async () => {
    const { cache } = await fixture()
    const file = join(cache, 'ordinary')
    await writeFile(file, Buffer.alloc(1024 * 1024 + 7, 42))
    expect((await safeDelete(file)).success).toBe(true)
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
