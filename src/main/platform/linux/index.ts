import type { PlatformProvider } from '../types'
import { createLinuxPaths } from './paths'
import { createLinuxElevation } from './elevation'
import { createLinuxSecurity } from './security'
import { createLinuxCommands } from './commands'
import { createLinuxStartup } from './startup'
import { createLinuxPrivacy } from './privacy'
import { createLinuxServices } from './services'
import { createLinuxMalware } from './malware'
import { createLinuxBrowser } from './browser'
import { createLinuxMalwarePaths } from './malware-paths'
import { createLinuxNetwork } from './network'

export function createLinuxProvider(): PlatformProvider {
  return {
    platform: 'linux',
    paths: createLinuxPaths(),
    elevation: createLinuxElevation(),
    security: createLinuxSecurity(),
    commands: createLinuxCommands(),
    startup: createLinuxStartup(),
    privacy: createLinuxPrivacy(),
    services: createLinuxServices(),
    malware: createLinuxMalware(),
    browser: createLinuxBrowser(),
    malwarePaths: createLinuxMalwarePaths(),
    network: createLinuxNetwork()
  }
}
