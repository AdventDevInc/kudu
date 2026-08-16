import { describe, expect, it } from 'vitest'
import {
  buildLinuxElevationCommand,
  createLinuxElevation,
  getLinuxRelaunchExecutable,
} from './elevation'

describe('linux elevation', () => {
  describe('isAdmin', () => {
    it('returns whether the process uid is root', () => {
      const elevation = createLinuxElevation()
      const originalGetuid = process.getuid

      try {
        process.getuid = (() => 0) as typeof process.getuid
        expect(elevation.isAdmin()).toBe(true)

        process.getuid = (() => 1000) as typeof process.getuid
        expect(elevation.isAdmin()).toBe(false)
      } finally {
        process.getuid = originalGetuid
      }
    })
  })

  describe('getLinuxRelaunchExecutable', () => {
    it('prefers the original AppImage over its temporary mounted executable', () => {
      const exePath = '/tmp/.mount_Kudu123/kudu'
      const appImagePath = '/home/user/Applications/Kudu.AppImage'

      expect(getLinuxRelaunchExecutable(exePath, appImagePath, () => true))
        .toBe(appImagePath)
    })

    it('falls back to the executable for non-AppImage installs', () => {
      const exePath = '/usr/bin/kudu'

      expect(getLinuxRelaunchExecutable(exePath, undefined, () => true))
        .toBe(exePath)
    })

    it('ignores stale or non-absolute APPIMAGE values', () => {
      const exePath = '/usr/bin/kudu'

      expect(getLinuxRelaunchExecutable(exePath, '/missing/Kudu.AppImage', () => false))
        .toBe(exePath)
      expect(getLinuxRelaunchExecutable(exePath, 'Kudu.AppImage', () => true))
        .toBe(exePath)
    })
  })

  describe('buildLinuxElevationCommand', () => {
    it('waits for the current process before launching the elevated app', () => {
      const command = buildLinuxElevationCommand(
        '/home/user/Kudu.AppImage',
        '/home/user/.config/Kudu',
        { DISPLAY: ':0', HOME: '/home/user' },
        1234,
      )

      expect(command).toContain('while kill -0 1234 2>/dev/null; do sleep 0.05; done;')
      expect(command).toContain("DISPLAY=':0'")
      expect(command).toContain("HOME='/home/user'")
      expect(command).toContain("'/home/user/Kudu.AppImage' --no-sandbox")
      expect(command).toContain("--kudu-data-dir='/home/user/.config/Kudu'")
      expect(command).toMatch(/ > \/dev\/null 2>&1 &$/)
    })

    it('quotes paths and forwarded environment values for the shell', () => {
      const command = buildLinuxElevationCommand(
        "/home/user/Kudu's AppImage",
        "/home/user/Kudu's data",
        { DISPLAY: ":0'unsafe" },
        42,
      )

      expect(command).toContain("DISPLAY=':0'\\''unsafe'")
      expect(command).toContain("'/home/user/Kudu'\\''s AppImage'")
      expect(command).toContain("--kudu-data-dir='/home/user/Kudu'\\''s data'")
    })
  })
})
