import { spawnSync } from 'child_process'

/**
 * Flags required by Chromium's native Ozone abstraction layer to run
 * without an X11 or Wayland display server on Linux.
 *
 * NOTE: Chromium selects the Ozone platform during early native C++
 * initialization, before Electron's JavaScript runtime finishes loading.
 * Calling `app.commandLine.appendSwitch('ozone-platform', 'headless')` runs
 * too late for the native layer, which defaults to X11 and fatally aborts
 * with "Missing X server or $DISPLAY" if no display server is present (issue #614).
 * These flags must be present on the actual process command line (argv).
 */
export const LINUX_HEADLESS_FLAGS = [
  '--ozone-platform=headless',
  '--no-sandbox',
  '--disable-gpu'
] as const

/**
 * Checks whether the current process is running in headless mode on Linux
 * without the native Ozone platform flag, and should relaunch itself.
 */
export function shouldRelaunchForHeadlessLinux(
  platform: NodeJS.Platform = process.platform,
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (platform !== 'linux') return false
  if (env.KUDU_HEADLESS_REEXEC === '1') return false

  const isHeadlessMode = argv.includes('--cli') || argv.includes('--daemon')
  if (!isHeadlessMode) return false

  const hasOzonePlatform = argv.some((arg) => arg.startsWith('--ozone-platform='))
  return !hasOzonePlatform
}

/**
 * Computes the arguments to pass when relaunching in headless Linux mode,
 * prepending missing native flags while preserving all existing CLI arguments.
 */
export function getHeadlessLinuxArgs(argv: readonly string[] = process.argv): string[] {
  const flagsToAdd: string[] = []
  if (!argv.some((arg) => arg.startsWith('--ozone-platform='))) {
    flagsToAdd.push('--ozone-platform=headless')
  }
  if (!argv.includes('--no-sandbox')) {
    flagsToAdd.push('--no-sandbox')
  }
  if (!argv.includes('--disable-gpu')) {
    flagsToAdd.push('--disable-gpu')
  }

  return [...flagsToAdd, ...argv.slice(1)]
}

/**
 * If running on Linux in CLI or daemon mode without `--ozone-platform` on argv,
 * synchronously relaunch the process with native headless flags and exit with
 * the child's exit status.
 */
export function relaunchForHeadlessLinux(): void {
  if (!shouldRelaunchForHeadlessLinux()) return

  const args = getHeadlessLinuxArgs()
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      KUDU_HEADLESS_REEXEC: '1'
    }
  })

  if (result.error) {
    console.error('Failed to spawn headless Kudu process:', result.error)
    process.exit(1)
  }

  if (result.signal) {
    const code = result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1
    process.exit(code)
  }

  process.exit(result.status ?? 0)
}
