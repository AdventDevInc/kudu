import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, utimes, rm, readFile, symlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
const state = vi.hoisted(() => ({ root: '', exec: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => join(state.root, 'state') } }))
vi.mock('./exec-utf8', () => ({ execTracked: state.exec, psUtf8: (s: string) => s }))
vi.mock('../platform', () => ({
  getPlatform: () => ({
    paths: {
      uninstallLeftoverDirs: () => [
        { id: 'appdata', name: 'Roaming', path: join(state.root, 'data') },
        { id: 'programfiles', name: 'Program Files', path: join(state.root, 'installed') }
      ]
    }
  })
}))
import { scanForLeftovers } from './uninstall-leftovers'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const old = new Date(Date.now() - 60 * 86400000)
let programs: { displayName: string; publisher: string; installLocation: string }[]
let running: string
const owner = (name: string) => ({
  displayName: name,
  publisher: '',
  installLocation: join(state.root, 'installed', name)
})
async function cache(name = 'OldApp', file = 'data.bin') {
  const path = join(state.root, 'data', name, 'Cache')
  await mkdir(path, { recursive: true })
  await writeFile(join(path, file), Buffer.alloc(2048))
  await utimes(join(path, file), old, old)
  await utimes(path, old, old)
  await utimes(join(path, '..'), old, old)
  return path
}
async function observeOwner(name = 'OldApp') {
  programs.push(owner(name))
  await scanForLeftovers(() => null)
  programs = programs.filter((p) => p.displayName !== name)
}
beforeEach(async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  state.root = await mkdtemp(join(tmpdir(), 'kudu-leftovers-'))
  await mkdir(join(state.root, 'installed'))
  programs = [owner('Unrelated Software')]
  running = 'C:\\Windows\\System32\\svchost.exe'
  state.exec.mockReset().mockImplementation(async (_file: string, args: string[]) => ({
    stdout: args.at(-1)!.includes('ConvertTo-Json') ? JSON.stringify(programs) : running,
    stderr: ''
  }))
})
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  await rm(state.root, { recursive: true, force: true })
})
describe('standalone leftover safety through the production scanner', () => {
  it('never infers ownership from age or an unmatched folder name', async () => {
    await cache()
    expect(await scanForLeftovers(() => null)).toEqual([])
    expect(
      JSON.parse(await readFile(join(state.root, 'state', 'leftover-owners.json'), 'utf8'))
    ).toEqual(programs)
  })
  it('returns only disposable children of a previously observed, now absent owner', async () => {
    const path = await cache()
    await writeFile(join(path, '..', 'profile.json'), 'personal data')
    await observeOwner()
    const results = await scanForLeftovers(() => null)
    expect(results.flatMap((r) => r.items)).toEqual([
      expect.objectContaining({
        path,
        size: 2048,
        selected: false,
        recencyCutoff: expect.any(Number)
      })
    ])
  })
  it.each(['LGHUB', 'karing', 'AIMP', 'Claude', 'Hiddify'])(
    'protects installed %s data',
    async (name) => {
      await cache(name)
      await observeOwner(name)
      programs.push(owner(name))
      expect(await scanForLeftovers(() => null)).toEqual([])
    }
  )
  it('protects portable installs present in Program Files without a registry entry', async () => {
    await cache('LGHUB')
    await observeOwner('LGHUB')
    await mkdir(join(state.root, 'installed', 'LGHUB'))
    expect(await scanForLeftovers(() => null)).toEqual([])
  })
  it('protects an owner whose recorded install directory still exists elsewhere', async () => {
    const location = join(state.root, 'custom-location')
    await mkdir(location)
    await cache()
    programs.push({ ...owner('OldApp'), installLocation: location })
    await scanForLeftovers(() => null)
    programs.pop()
    expect(await scanForLeftovers(() => null)).toEqual([])
  })
  it.each(['karing', 'Claude'])(
    'cross-checks running %s processes against data folders',
    async (name) => {
      await cache(name)
      await observeOwner(name)
      running += '\nD:\\Apps\\' + name + '\\' + name + 'Service.exe'
      expect(await scanForLeftovers(() => null)).toEqual([])
    }
  )
  it.each([
    'Larian Studios',
    'RenPy',
    'EldenRing',
    'Naughty Dog',
    'Sucker Punch Productions',
    'KOJIMA PRODUCTIONS',
    'Arrowhead',
    'GSE Saves',
    'ludusavi',
    'BattlEye',
    'EasyAntiCheat',
    'EasyAntiCheat_EOS',
    'InstallShield Installation Information'
  ])('protects %s even with historical ownership', async (name) => {
    await cache(name)
    await observeOwner(name)
    expect(await scanForLeftovers(() => null)).toEqual([])
  })
  it.each(['slot.sl2', 'slot.lsv', 'slot.lsf', 'slot.save', 'slot.sav', 'slot.dat', 'slot.bak'])(
    'protects %s even inside a cache',
    async (file) => {
      await cache('OldApp', file)
      await observeOwner()
      expect(await scanForLeftovers(() => null)).toEqual([])
    }
  )
  it('checks nested contents beyond the old 20-entry sample', async () => {
    const path = await cache()
    for (let i = 0; i < 25; i++) {
      const file = join(path, 'a' + i)
      await writeFile(file, 'old')
      await utimes(file, old, old)
    }
    await mkdir(join(path, 'z-nested'))
    await writeFile(join(path, 'z-nested', 'recent'), 'new')
    await utimes(join(path, 'z-nested'), old, old)
    await utimes(path, old, old)
    await observeOwner()
    expect(await scanForLeftovers(() => null)).toEqual([])
  })
  it('does not traverse directory junctions/symlinks', async () => {
    const path = await cache()
    const elsewhere = join(state.root, 'elsewhere')
    await mkdir(elsewhere)
    await writeFile(join(elsewhere, 'save.lsv'), 'save')
    await symlink(elsewhere, join(path, 'linked'), 'junction')
    await utimes(path, old, old)
    await observeOwner()
    expect(await scanForLeftovers(() => null)).toEqual([])
  })
  it('fails closed on inventory errors without overwriting ownership history', async () => {
    await observeOwner()
    const before = await readFile(join(state.root, 'state', 'leftover-owners.json'), 'utf8')
    state.exec.mockRejectedValue(new Error('Access denied'))
    await expect(scanForLeftovers(() => null)).rejects.toThrow('Access denied')
    expect(await readFile(join(state.root, 'state', 'leftover-owners.json'), 'utf8')).toBe(before)
  })
  it.each(['', '{}', '[]', '[{"displayName":"Incomplete"}]'])(
    'rejects incomplete registry output %s',
    async (stdout) => {
      state.exec.mockResolvedValue({ stdout, stderr: '' })
      await expect(scanForLeftovers(() => null)).rejects.toThrow()
    }
  )
  it('fails closed on running-process enumeration failure', async () => {
    state.exec.mockImplementation(async (_file: string, args: string[]) => {
      if (!args.at(-1)!.includes('ConvertTo-Json')) throw new Error('Process query failed')
      return { stdout: JSON.stringify(programs) }
    })
    await expect(scanForLeftovers(() => null)).rejects.toThrow('Process query failed')
  })
  it('does not treat unsupported platforms as an empty Windows inventory', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    await expect(scanForLeftovers(() => null)).rejects.toThrow('requires Windows')
    expect(state.exec).not.toHaveBeenCalled()
  })
})
