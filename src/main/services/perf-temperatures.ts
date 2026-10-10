import * as si from 'systeminformation'
import type { PerfTemperatures } from '../../shared/types'
import { collectWindowsCpuTemperatures } from './perf-windows-temperatures'

// Providers use 0 and -1 for missing sensors. Never display them as real readings.
export function temperatureCelsius(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 150
    ? value
    : null
}

export async function collectTemperatures(): Promise<PerfTemperatures> {
  const [cpu, graphics] = await Promise.allSettled([
    process.platform === 'win32' ? collectWindowsCpuTemperatures() : si.cpuTemperature(),
    si.graphics()
  ])
  return {
    sampledAt: Date.now(),
    cpuCelsius: cpu.status === 'fulfilled' ? temperatureCelsius(cpu.value.main) : null,
    cpuMaxCelsius: cpu.status === 'fulfilled' ? temperatureCelsius(cpu.value.max) : null,
    gpus:
      graphics.status === 'fulfilled'
        ? graphics.value.controllers.map((gpu) => ({
            name: gpu.model,
            celsius: temperatureCelsius(gpu.temperatureGpu)
          }))
        : []
  }
}
