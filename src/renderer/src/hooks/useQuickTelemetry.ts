import { useEffect, useState } from 'react'
import type { PerfQuickStats } from '@shared/types'

export interface QuickSample {
  at: number
  cpu: number
  memory: number
}

/** A bounded, single-flight sampler. Home never starts expensive process monitoring. */
export function useQuickTelemetry() {
  const [current, setCurrent] = useState<PerfQuickStats | null>(null)
  const [samples, setSamples] = useState<QuickSample[]>([])
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (seed = false) => {
      try {
        const reading = await window.kudu?.perfQuickStats?.()
        if (!cancelled && reading && !seed) {
          setCurrent(reading)
          setSamples((previous) => [
            ...previous.slice(-59),
            { at: Date.now(), cpu: reading.cpuPercent, memory: reading.memPercent }
          ])
        }
      } catch {
        if (!cancelled) setCurrent(null)
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), seed ? 1000 : 3000)
      }
    }
    void poll(true)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])
  return { current, samples }
}
