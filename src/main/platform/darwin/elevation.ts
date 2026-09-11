import type { PlatformElevation } from '../types'

export function createDarwinElevation(): PlatformElevation {
  return {
    isAdmin(): boolean {
      return process.getuid?.() === 0
    }
  }
}
