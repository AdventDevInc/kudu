import type { PlatformProvider } from '../types'
import { createWin32Paths } from './paths'
import { createWin32Elevation } from './elevation'
import { createWin32Security } from './security'
import { createWin32Commands } from './commands'
import { createWin32Startup } from './startup'
import { createWin32Privacy } from './privacy'
import { createWin32Services } from './services'
import { createWin32Malware } from './malware'
import { createWin32Browser } from './browser'
import { createWin32MalwarePaths } from './malware-paths'
import { createWin32Network } from './network'

export function createWin32Provider(): PlatformProvider {
  return {
    platform: 'win32',
    paths: createWin32Paths(),
    elevation: createWin32Elevation(),
    security: createWin32Security(),
    commands: createWin32Commands(),
    startup: createWin32Startup(),
    privacy: createWin32Privacy(),
    services: createWin32Services(),
    malware: createWin32Malware(),
    browser: createWin32Browser(),
    malwarePaths: createWin32MalwarePaths(),
    network: createWin32Network()
  }
}
