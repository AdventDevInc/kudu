import { execFileSync } from 'child_process'
import type { PlatformElevation } from '../types'

let _isAdmin: boolean | null = null

// Check the security token inherited from Kudu rather than probing a Windows
// service. `net session` also requires the Server (LanmanServer) service, so it
// reports access denied on elevated systems where that service is disabled.
const ADMIN_TOKEN_CHECK = [
  '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
  '$principal = [Security.Principal.WindowsPrincipal]::new($identity)',
  '$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  'if ($isAdmin) { exit 0 }',
  'exit 1',
].join('; ')

export function createWin32Elevation(): PlatformElevation {
  return {
    isAdmin(): boolean {
      if (_isAdmin !== null) return _isAdmin

      try {
        execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', ADMIN_TOKEN_CHECK],
          { stdio: 'ignore', timeout: 5000, windowsHide: true }
        )
        _isAdmin = true
      } catch {
        _isAdmin = false
      }

      return _isAdmin
    },
  }
}
