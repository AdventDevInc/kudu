// Win32 service management delegates to the existing service-manager.ipc.ts
// which contains all the WMI/CIM enumeration and modification logic.

import type { PlatformServices } from '../types'
import type {
  ServiceScanResult,
  ServiceApplyResult,
  ServiceScanProgress
} from '../../../shared/types'

export function createWin32Services(): PlatformServices {
  return {
    async scan(onProgress?: (data: ServiceScanProgress) => void): Promise<ServiceScanResult> {
      const { scanServices } = require('../../ipc/service-manager.ipc')
      return scanServices(onProgress)
    },

    async applyChanges(
      changes: Array<{ name: string; targetStartType: string }>
    ): Promise<ServiceApplyResult> {
      const { applyServiceChanges } = require('../../ipc/service-manager.ipc')
      return applyServiceChanges(changes)
    }
  }
}
