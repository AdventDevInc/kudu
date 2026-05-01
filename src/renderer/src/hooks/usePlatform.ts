import { createContext, useContext, useEffect, useState } from 'react'
import type { PlatformInfo } from '../../../shared/types'

const defaultInfo: PlatformInfo = {
  platform: 'win32',
  features: { registry: true, debloater: true, drivers: true, restorePoint: true, bootTrace: true, gameMode: true, firewallAudit: true },
}

const PlatformContext = createContext<PlatformInfo>(defaultInfo)

export function usePlatform(): PlatformInfo {
  return useContext(PlatformContext)
}

export function usePlatformLoader(): PlatformInfo {
  const [info, setInfo] = useState<PlatformInfo>(defaultInfo)
  useEffect(() => {
    window.kudu?.platformInfo?.().then(setInfo).catch(() => {})
  }, [])
  return info
}

export { PlatformContext }
