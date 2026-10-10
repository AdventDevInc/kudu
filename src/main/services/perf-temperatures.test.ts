import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ cpu: vi.fn(), graphics: vi.fn() }))
vi.mock('systeminformation', () => ({ cpuTemperature: mocks.cpu, graphics: mocks.graphics }))
vi.mock('./perf-windows-temperatures', () => ({ collectWindowsCpuTemperatures: mocks.cpu }))
import { collectTemperatures, temperatureCelsius } from './perf-temperatures'

describe('temperature sensor collection', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.cpu.mockResolvedValue({ main: 52.5, max: 61 })
    mocks.graphics.mockResolvedValue({ controllers: [{ model: 'GPU A', temperatureGpu: 45 }] })
  })

  it.each([-1, 0, NaN, Infinity, 150, undefined, null, '45'])(
    'rejects missing or invalid sensor value %s',
    (value) => {
      expect(temperatureCelsius(value)).toBeNull()
    }
  )

  it('retains CPU readings and all GPUs, including unavailable sensors', async () => {
    mocks.graphics.mockResolvedValue({
      controllers: [
        { model: 'GPU A', temperatureGpu: 45 },
        { model: 'GPU B', temperatureGpu: -1 }
      ]
    })
    expect(await collectTemperatures()).toEqual({
      sampledAt: expect.any(Number),
      cpuCelsius: 52.5,
      cpuMaxCelsius: 61,
      gpus: [
        { name: 'GPU A', celsius: 45 },
        { name: 'GPU B', celsius: null }
      ]
    })
  })

  it('keeps working GPU readings when the CPU provider fails', async () => {
    mocks.cpu.mockRejectedValue(new Error('unsupported'))
    expect(await collectTemperatures()).toMatchObject({
      cpuCelsius: null,
      cpuMaxCelsius: null,
      gpus: [{ name: 'GPU A', celsius: 45 }]
    })
  })

  it('keeps working CPU readings when the GPU provider fails', async () => {
    mocks.graphics.mockRejectedValue(new Error('unsupported'))
    expect(await collectTemperatures()).toMatchObject({ cpuCelsius: 52.5, gpus: [] })
  })
})
