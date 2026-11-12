import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const mocks = vi.hoisted(() => ({
  root: '',
  energy: {
    '-b': { sleep: 0, displaysleep: 10, lowpowermode: 0 },
    '-c': { sleep: 0, displaysleep: 15, lowpowermode: 0 }
  } as Record<string, Record<string, number>>,
  defaults: new Map<string, { type: string; value: string }>(),
  failAfter: -1
}))
vi.mock('electron', () => ({ app: { getPath: () => mocks.root } }))
vi.mock('systeminformation', () => ({ default: { battery: async () => ({ hasBattery: false }) } }))
vi.mock('../platform/darwin/privacy', () => ({
  isDefaultsValue: (value: any) =>
    value === null ||
    (!!value && typeof value.type === 'string' && typeof value.value === 'string'),
  readUserDefault: async (domain: string, key: string) =>
    mocks.defaults.get(domain + ':' + key) ?? null,
  elevatedBatch: vi.fn(async (commands: Array<{ args: string[] }>) => {
    for (const [index, command] of commands.entries()) {
      if (index === mocks.failAfter) throw new Error('authorization or command failure')
      const [source, ...pairs] = command.args
      for (let i = 0; i < pairs.length; i += 2)
        mocks.energy[source][pairs[i]] = Number(pairs[i + 1])
    }
  })
}))
vi.mock('util', async (original) => ({
  ...(await original<typeof import('util')>()),
  promisify:
    (fn: Function) =>
    (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        fn(...args, (error: Error | null, stdout: string, stderr: string) => {
          if (error) reject(error)
          else resolve({ stdout, stderr })
        })
      })
}))
vi.mock('child_process', () => ({
  execFile: vi.fn((file, args, options, callback) => {
    let stdout = ''
    if (file === '/usr/bin/pmset') {
      stdout = Object.entries(mocks.energy)
        .map(
          ([source, values]) =>
            (source === '-b' ? 'Battery Power' : 'AC Power') +
            ':\n' +
            Object.entries(values)
              .map(([key, value]) => ' ' + key + ' ' + value)
              .join('\n')
        )
        .join('\n')
    }
    if (file === '/usr/bin/defaults') {
      const [action, domain, key, type, value] = args
      if (action === 'delete') mocks.defaults.delete(domain + ':' + key)
      else mocks.defaults.set(domain + ':' + key, { type: type.slice(1), value })
    }
    callback(null, stdout, '')
  })
}))
import {
  animationReport,
  applyMacTool,
  batteryReport,
  energyReport,
  parseEnergy
} from './mac-tools'

describe('energy parsing', () => {
  it('keeps supported per-source values without mixing power profiles', () => {
    expect(
      parseEnergy(
        'Battery Power:\n sleep 0\n displaysleep 5\n womp 1\nAC Power:\n sleep 30\n lowpowermode 0'
      )
    ).toEqual({
      '-b': { sleep: 0, displaysleep: 5 },
      '-c': { sleep: 30, lowpowermode: 0 }
    })
  })
})

describe.skipIf(process.platform !== 'darwin')('Mac tools profile changes', () => {
  beforeEach(async () => {
    mocks.root = await realpath(await mkdtemp(join(tmpdir(), 'kudu-mac-profile-test-')))
    mocks.defaults.clear()
    mocks.energy = {
      '-b': { sleep: 0, displaysleep: 10, lowpowermode: 0 },
      '-c': { sleep: 0, displaysleep: 15, lowpowermode: 0 }
    }
    mocks.failAfter = -1
  })
  afterEach(() => rm(mocks.root, { recursive: true, force: true }))

  it('applies profiles by source and restores the initial values across multiple applications', async () => {
    const original = structuredClone(mocks.energy)
    await applyMacTool({ kind: 'energy', profile: 'eco' })
    expect(mocks.energy['-b']).toEqual({ sleep: 15, displaysleep: 5, lowpowermode: 1 })
    expect(mocks.energy['-c'].lowpowermode).toBe(0)
    await applyMacTool({ kind: 'energy', profile: 'balanced' })
    expect((await energyReport()).canRestore).toBe(true)
    await applyMacTool({ kind: 'energy', profile: 'restore' })
    expect(mocks.energy).toEqual(original)
    expect((await energyReport()).canRestore).toBe(false)
  })
  it('retains a restorable snapshot after a partially failed energy application', async () => {
    const original = structuredClone(mocks.energy)
    mocks.failAfter = 1
    await expect(applyMacTool({ kind: 'energy', profile: 'eco' })).rejects.toThrow()
    mocks.failAfter = -1
    await applyMacTool({ kind: 'energy', profile: 'restore' })
    expect(mocks.energy).toEqual(original)
  })
  it('refuses restoration over independent energy changes', async () => {
    await applyMacTool({ kind: 'energy', profile: 'eco' })
    mocks.energy['-b'].sleep = 99
    await expect(applyMacTool({ kind: 'energy', profile: 'restore' })).rejects.toThrow(
      'outside Kudu'
    )
  })
  it('restores absent animation keys and preserves the initial snapshot across profiles', async () => {
    await applyMacTool({ kind: 'animations', profile: 'fast' })
    expect(mocks.defaults.size).toBe(6)
    await applyMacTool({ kind: 'animations', profile: 'reduced' })
    expect((await animationReport()).canRestore).toBe(true)
    await applyMacTool({ kind: 'animations', profile: 'restore' })
    expect(mocks.defaults.size).toBe(0)
    expect((await animationReport()).canRestore).toBe(false)
  })
  it('rejects unrecognized actions and reports absence of a battery', async () => {
    await expect(applyMacTool({ kind: 'energy', profile: 'custom' })).rejects.toThrow('Unsupported')
    await expect(applyMacTool({ kind: 'shell', command: 'anything' })).rejects.toThrow(
      'Unsupported'
    )
    expect((await batteryReport()).readings).toEqual([{ label: 'batteryPresent', value: 'false' }])
  })
})
