import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
const state = vi.hoisted(() => ({ items: [] as any[] }))
vi.mock('./settings-store', () => ({ getSettings: () => ({ cleaner: { secureDelete: false }, exclusions: [] }) }))
vi.mock('./scan-cache', () => ({ getCachedItems: () => state.items, removeCachedItems: () => {} }))
vi.mock('./deletion-log-store', () => ({ recordDeletions: () => {} }))
import { cleanItems, getDirectorySize } from './file-utils'
const roots: string[] = []
async function root() { const p = await mkdtemp(join(tmpdir(), 'kudu-measure-')); roots.push(p); return p }
afterEach(async () => { state.items = []; for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }) })
function item(path: string, size: number, id = 'one') { return { id, path, size, category: 'app', subcategory: 'cache', selected: true, lastModified: 0 } }
describe('cleanup measurements', () => {
  it('includes deep files but excludes junction targets from sizing', async () => {
    const p = await root(); const cache = join(p, 'cache'); const deep = join(cache, 'a', 'b', 'c', 'd')
    const outside = join(p, 'outside'); await mkdir(deep, { recursive: true }); await mkdir(outside)
    await writeFile(join(deep, 'data'), Buffer.alloc(4096)); await writeFile(join(outside, 'keep'), Buffer.alloc(8192))
    await symlink(outside, join(cache, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await getDirectorySize(cache)).toBe(4096)
  })
  it('uses current file size instead of the cached estimate', async () => {
    const p = await root(); const file = join(p, 'data'); await writeFile(file, Buffer.alloc(37))
    state.items = [item(file, 9000)]
    expect((await cleanItems(['one'])).totalCleaned).toBe(37)
  })
  it('honors explicit depth limits without truncating default cleanup sizing', async () => {
    const p = await root()
    await mkdir(join(p, 'a', 'b'), { recursive: true })
    await writeFile(join(p, 'top'), Buffer.alloc(10))
    await writeFile(join(p, 'a', 'middle'), Buffer.alloc(20))
    await writeFile(join(p, 'a', 'b', 'deep'), Buffer.alloc(30))
    expect(await getDirectorySize(p, 0)).toBe(0)
    expect(await getDirectorySize(p, 1)).toBe(10)
    expect(await getDirectorySize(p, 2)).toBe(30)
    expect(await getDirectorySize(p)).toBe(60)
  })
  it('does not double-count overlapping parent and child selections', async () => {
    const p = await root(); const file = join(p, 'data'); await writeFile(file, Buffer.alloc(37))
    state.items = [item(file, 37, 'child'), item(p, 37, 'parent')]
    expect((await cleanItems(['parent', 'child'])).totalCleaned).toBe(37)
  })
})
