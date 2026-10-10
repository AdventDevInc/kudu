import { execFile } from 'child_process'
import { promisify } from 'util'
import { psUtf8 } from './exec-utf8'

const execFileAsync = promisify(execFile)

// ACPI thermal zones are not CPU sensors. Read explicitly CPU-owned sensors
// from an already-running hardware monitor; do not install or start a driver.
export async function collectWindowsCpuTemperatures(): Promise<{ main: number; max: number }> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      psUtf8(`
      foreach ($namespace in @('root/LibreHardwareMonitor', 'root/OpenHardwareMonitor')) {
        try {
          $cpus = @(Get-CimInstance -Namespace $namespace -ClassName Hardware -ErrorAction Stop | Where-Object { $_.HardwareType -eq 'Cpu' } | Select-Object -ExpandProperty Identifier)
          $sensors = @(Get-CimInstance -Namespace $namespace -ClassName Sensor -ErrorAction Stop | Where-Object { $_.SensorType -eq 'Temperature' -and $_.Parent -in $cpus } | Select-Object Name, Value)
          if ($sensors.Count -gt 0) { ConvertTo-Json -InputObject $sensors -Compress; break }
        } catch { }
      }
    `)
    ],
    { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 }
  )
  return parseWindowsCpuTemperatures(stdout)
}

export function parseWindowsCpuTemperatures(stdout: string): { main: number; max: number } {
  const parsed: unknown = JSON.parse(stdout.trim() || '[]')
  const sensors = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (sensor): sensor is { Name: string; Value: number } =>
      sensor !== null &&
      typeof sensor === 'object' &&
      typeof sensor.Name === 'string' &&
      typeof sensor.Value === 'number' &&
      Number.isFinite(sensor.Value) &&
      sensor.Value > 0 &&
      sensor.Value < 150
  )
  const packages = sensors.filter((sensor) => /package|tctl|tdie|cpu die/i.test(sensor.Name))
  const primary = packages.length ? packages : sensors
  return {
    main: primary.length
      ? primary.reduce((sum, sensor) => sum + sensor.Value, 0) / primary.length
      : -1,
    max: sensors.length ? Math.max(...sensors.map((sensor) => sensor.Value)) : -1
  }
}
