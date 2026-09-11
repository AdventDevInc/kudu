// Win32 privacy settings delegate to the existing privacy-shield.ipc.ts
// which contains all 30+ registry-based setting definitions.

import type { PlatformPrivacy, PrivacySettingDef } from '../types'

export function createWin32Privacy(): PlatformPrivacy {
  return {
    getSettings(): PrivacySettingDef[] {
      const { PRIVACY_SETTINGS } = require('../../ipc/privacy-shield.ipc')
      return PRIVACY_SETTINGS
    }
  }
}
