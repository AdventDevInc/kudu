import type { PlatformProvider } from '../types'
import { createDarwinPaths } from './paths'
import { createDarwinElevation } from './elevation'
import { createDarwinSecurity } from './security'
import { createDarwinCommands } from './commands'
import { createDarwinStartup } from './startup'
import { createDarwinPrivacy } from './privacy'
import { createDarwinServices } from './services'
import { createDarwinMalware } from './malware'
import { createDarwinBrowser } from './browser'
import { createDarwinMalwarePaths } from './malware-paths'
import { createDarwinNetwork } from './network'

export function createDarwinProvider(): PlatformProvider {
  return {
    platform: 'darwin',
    paths: createDarwinPaths(),
    elevation: createDarwinElevation(),
    security: createDarwinSecurity(),
    commands: createDarwinCommands(),
    startup: createDarwinStartup(),
    privacy: createDarwinPrivacy(),
    services: createDarwinServices(),
    malware: createDarwinMalware(),
    browser: createDarwinBrowser(),
    malwarePaths: createDarwinMalwarePaths(),
    network: createDarwinNetwork()
  }
}
