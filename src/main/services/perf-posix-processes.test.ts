import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  readFile: vi.fn(),
  readlink: vi.fn(),
  readdir: vi.fn(),
  cachedProcesses: vi.fn()
}))
vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }) }
})
vi.mock('fs/promises', () => ({
  readFile: mocks.readFile,
  readlink: mocks.readlink,
  readdir: mocks.readdir
}))
vi.mock('os', () => ({ cpus: () => Array(4).fill({}) }))
vi.mock('systeminformation', () => ({ processes: mocks.cachedProcesses }))
import {
  PosixProcessSampler,
  getPosixProcessIdentity,
  parsePosixProcesses,
  intervalCpu
} from './perf-posix-processes'

function stat(name: string, birth: number, ticks = 900): string {
  const fields = Array(22).fill('0')
  fields[0] = 'S'
  fields[11] = String(ticks)
  fields[12] = '0'
  fields[19] = String(birth)
  return `123 (${name}) ${fields.join(' ')}`
}
const row = (name: string) => `123 1 25.0 1024 1000 Fri Oct  9 10:00:00 2026 ${name}\n`

describe('fresh native POSIX process telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    mocks.readdir.mockResolvedValue(['123', 'self', 'stat'])
    mocks.readlink.mockResolvedValue('/usr/bin/process B')
    mocks.readFile.mockResolvedValue(stat('process B', 200))
    mocks.exec.mockImplementation(async (command: string) => ({
      stdout: command.endsWith('getconf') ? '100\n' : row('process B')
    }))
    mocks.cachedProcesses.mockResolvedValue({
      list: [{ pid: 123, name: 'old A', started: 'old', memRss: 9999 }]
    })
  })
  afterEach(() => vi.restoreAllMocks())
  it('never binds stable B tokens to cached SI process A metadata', async () => {
    const {
      processes: [process]
    } = await new PosixProcessSampler().collect(4 * 1024 ** 2, 'linux')
    expect(process).toMatchObject({
      pid: 123,
      name: 'process B',
      path: '/usr/bin/process B',
      birthToken: 'linux:200',
      memBytes: 1024 ** 2,
      memPercent: 25,
      user: '1000'
    })
    expect(mocks.cachedProcesses).not.toHaveBeenCalled()
    expect(mocks.exec).toHaveBeenCalledWith(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,pcpu=,rss=,uid=,lstart=,comm='],
      expect.objectContaining({
        timeout: 5000,
        maxBuffer: 8 * 1024 ** 2,
        env: expect.objectContaining({ LC_ALL: 'C' })
      })
    )
  })
  it('discards a PID that was replaced during the uncached capture', async () => {
    mocks.readFile.mockResolvedValueOnce(stat('A', 100)).mockResolvedValueOnce(stat('B', 200))
    expect(await new PosixProcessSampler().collect(1e9, 'linux')).toEqual({
      processes: [],
      totalCount: 1
    })
  })
  it('preserves Linux interval CPU normalized to logical CPUs, instead of ps lifetime average', async () => {
    const sampler = new PosixProcessSampler()
    expect((await sampler.collect(1e9, 'linux')).processes[0].cpuPercent).toBe(0)
    vi.mocked(performance.now).mockReturnValue(11_000)
    mocks.readFile.mockResolvedValue(stat('process B', 200, 1000))
    expect((await sampler.collect(1e9, 'linux')).processes[0].cpuPercent).toBeCloseTo(2.5)
    expect(mocks.exec.mock.calls.filter(([command]) => command.endsWith('getconf'))).toHaveLength(1)
  })
  it('parses macOS executable paths with spaces and preserves OS ps CPU semantics', async () => {
    mocks.exec.mockResolvedValue({
      stdout: row('/Applications/My Browser.app/Contents/MacOS/My Browser')
    })
    const {
      processes: [process]
    } = await new PosixProcessSampler().collect(4 * 1024 ** 2, 'darwin')
    expect(process).toMatchObject({
      name: 'My Browser',
      path: '/Applications/My Browser.app/Contents/MacOS/My Browser',
      birthToken: 'darwin:Fri Oct 9 10:00:00 2026',
      cpuPercent: 25,
      memBytes: 1024 ** 2
    })
    expect(mocks.readFile).not.toHaveBeenCalled()
  })
  it('uses one fresh native identity/name for protected-process validation, never cached SI names', async () => {
    mocks.readFile.mockResolvedValue(stat('systemd', 200))
    expect(await getPosixProcessIdentity(123, 'linux')).toEqual({
      name: 'systemd',
      birthToken: 'linux:200'
    })
    mocks.exec.mockResolvedValue({ stdout: row('/sbin/launchd') })
    expect(await getPosixProcessIdentity(123, 'darwin')).toEqual({
      name: 'launchd',
      birthToken: 'darwin:Fri Oct 9 10:00:00 2026'
    })
    expect(mocks.cachedProcesses).not.toHaveBeenCalled()
  })
  it('rejects malformed rows and resets CPU for replacement identities or reversed counters', () => {
    expect(parsePosixProcesses('garbage\n123 incomplete', 1e9)).toEqual([])
    const old = { birthToken: 'linux:100', cpuTicks: 100, path: '', timestamp: 1000 }
    expect(intervalCpu(old, { ...old, birthToken: 'linux:200', timestamp: 2000 }, 100, 4)).toBe(0)
    expect(intervalCpu(old, { ...old, cpuTicks: 1, timestamp: 2000 }, 100, 4)).toBe(0)
  })
})
