import { describe, expect, it } from 'vitest'
import { parseWindowsCpuTemperatures } from './perf-windows-temperatures'

describe('Windows CPU sensors', () => {
  it('prefers package temperature over an average of cores and keeps the hottest sensor', () => {
    expect(
      parseWindowsCpuTemperatures(
        JSON.stringify([
          { Name: 'CPU Package', Value: 63 },
          { Name: 'CPU Core #1', Value: 50 },
          { Name: 'CPU Core #2', Value: 70 },
          { Name: 'CPU Core #3', Value: 0 }
        ])
      )
    ).toEqual({ main: 63, max: 70 })
  })
  it('handles AMD package labels and a single sensor', () => {
    expect(parseWindowsCpuTemperatures('{"Name":"CPU (Tctl/Tdie)","Value":58.5}')).toEqual({
      main: 58.5,
      max: 58.5
    })
  })
  it('averages cores when no package sensor exists', () => {
    expect(
      parseWindowsCpuTemperatures('[{"Name":"Core #1","Value":40},{"Name":"Core #2","Value":50}]')
    ).toEqual({ main: 45, max: 50 })
  })
  it.each(['', '[]', 'null', '[{"Name":"CPU Package","Value":-1}]'])(
    'marks absent sensors unavailable: %s',
    (input) => {
      expect(parseWindowsCpuTemperatures(input)).toEqual({ main: -1, max: -1 })
    }
  )
})
