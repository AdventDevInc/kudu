import { execFile } from 'child_process'
import { readFile, readlink, readdir } from 'fs/promises'
import { promisify } from 'util'
import { basename } from 'path'
import * as os from 'os'
import { appKey } from '../../shared/perf-apps'
import type { PerfProcess } from '../../shared/types'
import { linuxBirthToken } from './perf-process-identity'

const execFileAsync = promisify(execFile)
const PS_FIELDS = 'pid=,ppid=,pcpu=,rss=,uid=,lstart=,comm='
const PS_OPTIONS = { timeout: 5000, maxBuffer: 8 * 1024 ** 2, env: { ...process.env, LC_ALL: 'C' } }

export function parsePosixProcesses(output: string, totalMem: number): PerfProcess[] {
  const processes: PerfProcess[] = []
  for (const line of output.split('\n')) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/
    )
    if (!match || !Number.isFinite(Date.parse(match[6]))) continue
    const [pid, parentPid, cpu, rss] = match.slice(1, 5).map(Number)
    if (![pid, parentPid, cpu, rss].every(Number.isFinite)) continue
    const command = match[7].trim()
    const path = command.startsWith('/') ? command : ''
    const name = path ? basename(path) : command
    const started = match[6].replace(/\s+/g, ' ')
    processes.push({
      pid,
      parentPid,
      name,
      path,
      user: match[5],
      started,
      birthToken: `darwin:${started}`,
      appKey: appKey(name, path, match[5], false),
      cpuPercent: cpu,
      memBytes: rss * 1024,
      memPercent: totalMem > 0 ? ((rss * 1024) / totalMem) * 100 : 0
    })
  }
  return processes
}

interface LinuxSample {
  birthToken: string
  cpuTicks: number
  path: string
  timestamp: number
}
export function linuxCpuTicks(stat: string): number | null {
  const fields = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)
  const user = Number(fields[11]),
    system = Number(fields[12])
  return Number.isFinite(user) && Number.isFinite(system) && user >= 0 && system >= 0
    ? user + system
    : null
}

async function linuxSamples(pids?: number[]): Promise<Map<number, LinuxSample>> {
  const samples = new Map<number, LinuxSample>()
  const ids = pids ?? (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry)).map(Number)
  for (let offset = 0; offset < ids.length; offset += 64) {
    await Promise.all(
      ids.slice(offset, offset + 64).map(async (pid) => {
        if (pid <= 0 || !Number.isInteger(pid)) return
        try {
          const path = await readlink(`/proc/${pid}/exe`).catch(() => '')
          const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
          const birthToken = linuxBirthToken(stat)
          const cpuTicks = linuxCpuTicks(stat)
          if (birthToken && cpuTicks !== null)
            samples.set(pid, { birthToken, cpuTicks, path, timestamp: performance.now() })
        } catch {
          /* Exited or inaccessible. */
        }
      })
    )
  }
  return samples
}

export function intervalCpu(
  previous: LinuxSample | undefined,
  current: LinuxSample,
  hz: number,
  cores: number
): number {
  if (
    !previous ||
    previous.birthToken !== current.birthToken ||
    current.timestamp <= previous.timestamp ||
    current.cpuTicks < previous.cpuTicks
  )
    return 0
  return Math.min(
    100,
    ((current.cpuTicks - previous.cpuTicks) /
      hz /
      ((current.timestamp - previous.timestamp) / 1000) /
      Math.max(1, cores)) *
      100
  )
}

export class PosixProcessSampler {
  private previous = new Map<number, LinuxSample>()
  private hz: number | null = null

  async collect(
    totalMem: number,
    platform = process.platform
  ): Promise<{ processes: PerfProcess[]; totalCount: number }> {
    const before = platform === 'linux' ? await linuxSamples() : new Map<number, LinuxSample>()
    if (platform === 'linux' && this.hz === null) {
      const { stdout } = await execFileAsync('/usr/bin/getconf', ['CLK_TCK'], { timeout: 2000 })
      const hz = Number(stdout.trim())
      if (!Number.isFinite(hz) || hz <= 0) throw new Error('CPU clock rate unavailable')
      this.hz = hz
    }
    // Fresh capture: never combine systeminformation's cached names/RSS with new birth tokens.
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', PS_FIELDS], PS_OPTIONS)
    let processes = parsePosixProcesses(stdout, totalMem)
    const totalCount = processes.length
    if (platform === 'linux') {
      const after = await linuxSamples(processes.map((p) => p.pid))
      processes = processes.filter((p) => {
        const current = after.get(p.pid)
        if (!current || before.get(p.pid)?.birthToken !== current.birthToken) return false
        p.birthToken = current.birthToken
        p.path = current.path
        if (p.path) p.name = basename(p.path)
        p.appKey = appKey(p.name, p.path, p.user, false)
        p.cpuPercent = intervalCpu(this.previous.get(p.pid), current, this.hz!, os.cpus().length)
        return true
      })
      this.previous = after
    }
    return { processes, totalCount }
  }
}

export async function getPosixProcessIdentity(
  pid: number,
  platform = process.platform
): Promise<{ name: string; birthToken: string } | null> {
  try {
    if (!Number.isInteger(pid) || pid <= 0) return null
    if (platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const birthToken = linuxBirthToken(stat)
      return birthToken
        ? { name: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')), birthToken }
        : null
    }
    const { stdout } = await execFileAsync(
      '/bin/ps',
      ['-p', String(pid), '-o', PS_FIELDS],
      PS_OPTIONS
    )
    const process = parsePosixProcesses(stdout, 0).find((p) => p.pid === pid)
    return process?.birthToken ? { name: process.name, birthToken: process.birthToken } : null
  } catch {
    return null
  }
}
