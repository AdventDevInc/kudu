import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.fn()

vi.mock('child_process', () => ({
  execFile: execFileMock,
}))

vi.mock('util', () => ({
  promisify: () => execFileMock,
}))

const { parseGpuRestartPayload, restartGpuDrivers } = await import('./gpu-restart')

describe('parseGpuRestartPayload', () => {
  it('parses a single device object', () => {
    expect(
      parseGpuRestartPayload(
        JSON.stringify({ Name: 'NVIDIA GeForce', InstanceId: 'PCI\\VEN_10DE' })
      )
    ).toEqual([{ name: 'NVIDIA GeForce', instanceId: 'PCI\\VEN_10DE' }])
  })

  it('parses an array of devices', () => {
    expect(
      parseGpuRestartPayload(
        JSON.stringify([
          { Name: 'Intel UHD', InstanceId: 'PCI\\VEN_8086' },
          { Name: 'NVIDIA', InstanceId: 'PCI\\VEN_10DE' },
        ])
      )
    ).toEqual([
      { name: 'Intel UHD', instanceId: 'PCI\\VEN_8086' },
      { name: 'NVIDIA', instanceId: 'PCI\\VEN_10DE' },
    ])
  })

  it('returns empty for blank or invalid JSON', () => {
    expect(parseGpuRestartPayload('')).toEqual([])
    expect(parseGpuRestartPayload('not-json')).toEqual([])
  })
})

describe('restartGpuDrivers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns restarted devices from PowerShell', async () => {
    execFileMock.mockResolvedValue({
      stdout: JSON.stringify([{ Name: 'Basic Display', InstanceId: 'ROOT\\DISPLAY' }]),
      stderr: '',
    })
    const result = await restartGpuDrivers()
    expect(result.ok).toBe(true)
    expect(result.devices).toEqual([{ name: 'Basic Display', instanceId: 'ROOT\\DISPLAY' }])
    expect(execFileMock).toHaveBeenCalled()
  })

  it('returns ok:false when PowerShell fails', async () => {
    execFileMock.mockRejectedValue(new Error('Access is denied'))
    const result = await restartGpuDrivers()
    expect(result.ok).toBe(false)
    expect(result.devices).toEqual([])
    expect(result.error).toMatch(/Access is denied/)
  })
})

describe('restartGpuDrivers script safety', () => {
  it('re-enables adapters in a finally block so a failure never leaves one disabled', async () => {
    execFileMock.mockResolvedValue({ stdout: '[]', stderr: '' })
    await restartGpuDrivers()
    const script = execFileMock.mock.calls[0][1][3] as string
    expect(script).toMatch(/try\s*\{[\s\S]*Disable-PnpDevice[\s\S]*\}\s*finally\s*\{[\s\S]*Enable-PnpDevice/)
    expect(script.indexOf('Disable-PnpDevice')).toBeLessThan(script.indexOf('finally'))
  })
})
