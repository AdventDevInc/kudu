import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PlatformServices } from '../types'
import type {
  ServiceScanResult,
  ServiceApplyResult,
  ServiceScanProgress
} from '../../../shared/types'

const execFileAsync = promisify(execFile)

export function createLinuxServices(): PlatformServices {
  return {
    async scan(onProgress?: (data: ServiceScanProgress) => void): Promise<ServiceScanResult> {
      try {
        const { stdout } = await execFileAsync(
          '/usr/bin/systemctl',
          ['list-units', '--type=service', '--no-pager', '--plain', '--all'],
          { timeout: 15_000 }
        )

        const lines = stdout.trim().split('\n').slice(1) // skip header
        const services: ServiceScanResult['services'] = []
        let running = 0
        let disabled = 0

        for (let i = 0; i < lines.length; i++) {
          const parts = lines[i].trim().split(/\s+/)
          if (parts.length < 4) continue
          const [unit, load, active, sub, ...descParts] = parts

          if (!unit.endsWith('.service') || load === 'not-found') continue

          const isRunning = active === 'active'
          if (isRunning) running++
          if (active === 'inactive' && sub === 'dead') disabled++

          services.push({
            name: unit.replace('.service', ''),
            displayName: unit.replace('.service', ''),
            description: descParts.join(' '),
            status: isRunning ? 'Running' : 'Stopped',
            startType: 'Manual',
            safety: 'caution',
            category: 'misc',
            isMicrosoft: false,
            dependsOn: [],
            dependents: [],
            selected: false,
            originalStartType: 'Manual'
          })

          if (onProgress) {
            onProgress({
              phase: 'enumerating',
              current: i,
              total: lines.length,
              currentService: unit
            })
          }
        }

        return {
          services,
          totalCount: services.length,
          runningCount: running,
          disabledCount: disabled,
          safeToDisableCount: 0
        }
      } catch {
        return {
          services: [],
          totalCount: 0,
          runningCount: 0,
          disabledCount: 0,
          safeToDisableCount: 0
        }
      }
    },

    async applyChanges(
      changes: Array<{ name: string; targetStartType: string }>
    ): Promise<ServiceApplyResult> {
      const errors: ServiceApplyResult['errors'] = []
      let succeeded = 0

      for (const change of changes) {
        try {
          const action = change.targetStartType === 'Disabled' ? 'disable' : 'enable'
          await execFileAsync('/usr/bin/systemctl', [action, change.name], { timeout: 10_000 })
          succeeded++
        } catch (err: any) {
          errors.push({ name: change.name, displayName: change.name, reason: err.message })
        }
      }

      return { succeeded, failed: errors.length, errors }
    }
  }
}
