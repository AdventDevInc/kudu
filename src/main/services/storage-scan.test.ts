import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
const state = vi.hoisted(() => ({ blocked: '' }))
vi.mock('./file-utils', () => ({
  isExcluded: (path: string, exclusions: string[]) => exclusions.includes(path)
}))
vi.mock('fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('fs/promises')>()
  return {
    ...actual,
    opendir: async (path: string) => {
      if (path === state.blocked) throw new Error('Access denied')
      return actual.opendir(path)
    }
  }
})
import { measureStorageScope, validateStorageRoot } from './storage-scan'
let root = ''
beforeEach(async () => {
  // macOS /var and Windows 8.3 temp paths are aliases, which the scanner refuses.
  root = await mkdtemp(join(await realpath(tmpdir()), 'kudu-storage-test-'))
  state.blocked = ''
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const capture = (exclusions: string[] = []) =>
  measureStorageScope(root, exclusions, new AbortController().signal)
it('measures deep files while retaining only three levels of folder detail', async () => {
  await mkdir(join(root, 'a/b/c/deep'), { recursive: true })
  await writeFile(join(root, 'a/b/c/deep/file'), Buffer.alloc(123))
  await writeFile(join(root, 'root-file'), Buffer.alloc(7))
  const result = await capture()
  expect(result).toMatchObject({ status: 'complete', totalBytes: 130, files: 2 })
  expect(result.rows).toContainEqual({ path: 'a/b/c', bytes: 123, files: 1 })
  expect(result.rows.some((r) => r.path.includes('deep'))).toBe(false)
})
it('does not follow a junction or collect an excluded file', async () => {
  await mkdir(join(root, 'actual'))
  await writeFile(join(root, 'actual/file'), Buffer.alloc(50))
  await symlink(
    join(root, 'actual'),
    join(root, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await writeFile(join(root, 'excluded'), Buffer.alloc(200))
  expect(await capture([join(root, 'excluded')])).toMatchObject({
    status: 'complete',
    totalBytes: 50,
    skipped: 2
  })
  await expect(validateStorageRoot(join(root, 'alias'))).rejects.toThrow('Linked folders')
})
it('reports inaccessible branches as partial rather than pretending their size is zero', async () => {
  await mkdir(join(root, 'blocked'))
  state.blocked = join(root, 'blocked')
  expect(await capture()).toMatchObject({ status: 'partial', errors: 1, reason: 'inaccessible' })
})
it('bounds traversal and yields the event loop during large captures', async () => {
  await Promise.all(
    Array.from({ length: 300 }, (_, i) => writeFile(join(root, String(i)), Buffer.alloc(1)))
  )
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  try {
    const result = await measureStorageScope(root, [], new AbortController().signal, {
      entries: 200,
      directories: 10,
      rows: 10,
      milliseconds: 30000
    })
    expect(result.status).toBe('partial')
    expect(result.reason).toBe('limit')
    expect(result.files).toBeLessThanOrEqual(200)
    expect(ticks).toBeGreaterThan(0)
  } finally {
    clearInterval(timer)
  }
})
it('keeps cancelled captures distinct from completed zero-byte snapshots', async () => {
  const controller = new AbortController()
  controller.abort()
  expect(await measureStorageScope(root, [], controller.signal)).toMatchObject({
    status: 'cancelled',
    reason: 'cancelled'
  })
})
it.skipIf(process.platform !== 'win32')(
  'accepts a Windows 8.3 short-name root as the same folder',
  async ({ skip }) => {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub/file'), Buffer.alloc(9))
    const short = execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${root}').ShortPath`
    ])
      .toString()
      .trim()
    // Volumes with 8.3 name generation disabled return the long path unchanged.
    if (short.toLowerCase() === root.toLowerCase()) skip()
    expect(await measureStorageScope(short, [], new AbortController().signal)).toMatchObject({
      status: 'complete',
      totalBytes: 9,
      files: 1
    })
  }
)
