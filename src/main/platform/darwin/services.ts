import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PlatformServices } from '../types'
import type {
  ServiceScanResult,
  ServiceApplyResult,
  ServiceScanProgress
} from '../../../shared/types'

const execFileAsync = promisify(execFile)

export function createDarwinServices(): PlatformServices {
  return {
    async scan(onProgress?: (data: ServiceScanProgress) => void): Promise<ServiceScanResult> {
      try {
        const { stdout } = await execFileAsync('/bin/launchctl', ['list'], { timeout: 15_000 })
        const lines = stdout.trim().split('\n').slice(1) // skip header

        const services: ServiceScanResult['services'] = []
        let running = 0
        let disabled = 0

        for (let i = 0; i < lines.length; i++) {
          const parts = lines[i].trim().split('\t')
          if (parts.length < 3) continue
          const [pid, , label] = parts

          // Skip Apple system services
          if (label.startsWith('com.apple.') || label.startsWith('[')) continue

          const isRunning = pid !== '-'
          if (isRunning) running++
          else disabled++

          services.push({
            name: label,
            displayName: label,
            description: '',
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
              currentService: label
            })
          }
        }

        return {
          services,
          totalCount: services.length,
          runningCount: running,
          disabledCount: disabled,
          safeToDisableCount: services.filter((s) => s.safety === 'safe').length
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
          if (change.targetStartType === 'Disabled') {
            await execFileAsync(
              '/bin/launchctl',
              ['disable', `gui/${process.getuid?.() ?? 501}/${change.name}`],
              { timeout: 10_000 }
            )
          } else {
            await execFileAsync(
              '/bin/launchctl',
              ['enable', `gui/${process.getuid?.() ?? 501}/${change.name}`],
              { timeout: 10_000 }
            )
          }
          succeeded++
        } catch (err: any) {
          errors.push({ name: change.name, displayName: change.name, reason: err.message })
        }
      }

      return { succeeded, failed: errors.length, errors }
    }
  }
}
