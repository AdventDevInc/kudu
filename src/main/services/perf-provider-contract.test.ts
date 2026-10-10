import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { runInNewContext } from 'vm'
import type { Systeminformation } from 'systeminformation'
import { mapPerfProcesses } from './perf-processes'

const dependencyRequire = createRequire(import.meta.url)
const providerPath = join(dirname(dependencyRequire.resolve('systeminformation')), 'processes.js')

describe('installed systeminformation Windows memory contract', () => {
  it.each([1024 ** 2, 3 * 1024 ** 3])(
    'restores native WorkingSetSize %d through the real provider parser',
    async (workingSetBytes) => {
      const totalMemBytes = 4 * 1024 ** 3
      const powerShell = vi.fn(async () =>
        JSON.stringify([
          {
            ProcessId: 123,
            ParentProcessId: 1,
            Caption: 'sample.exe',
            ExecutablePath: 'C:\\Apps\\sample.exe',
            WorkingSetSize: workingSetBytes,
            UserModeTime: 100,
            KernelModeTime: 10,
            CreationDate: '2026-01-01 10:00:00'
          }
        ])
      )
      const dependencyExports = {} as { processes: () => Promise<Systeminformation.ProcessesData> }

      // Execute the installed/patched provider itself, rather than reproducing its
      // conversion in a test fixture. Only its OS boundary is replaced. This runs
      // the Windows provider on every CI OS and detects a future SI unit change.
      runInNewContext(
        readFileSync(providerPath, 'utf8'),
        {
          exports: dependencyExports,
          process: { platform: 'win32', nextTick: process.nextTick },
          require: (name: string) => {
            if (name === './util') return { powerShell }
            if (name === 'os') return { totalmem: () => totalMemBytes }
            if (name === 'fs') return {}
            if (name === 'path') return dependencyRequire('path')
            if (name === 'child_process') return { exec: vi.fn(), execSync: vi.fn() }
            throw new Error(`Unexpected provider dependency: ${name}`)
          }
        },
        { filename: providerPath, timeout: 1000 }
      )

      const data = await dependencyExports.processes()
      expect(powerShell).toHaveBeenCalledOnce()
      expect(data.list).toHaveLength(1)
      expect(data.list[0].memRss).toBe(workingSetBytes / 1024)
      const [mapped] = mapPerfProcesses(data.list, totalMemBytes, true)
      expect(mapped.memBytes).toBe(workingSetBytes)
      expect(mapped.memPercent).toBe((workingSetBytes / totalMemBytes) * 100)
    }
  )
})
