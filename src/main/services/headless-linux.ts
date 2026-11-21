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
  argv: readonly string[] = process.argv
): boolean {
  if (platform !== 'linux') return false

  const isHeadlessMode = argv.includes('--cli') || argv.includes('--daemon')
  if (!isHeadlessMode) return false

  return !hasOzonePlatform(argv)
}

function hasOzonePlatform(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='))
}

/**
 * Computes the arguments to pass when relaunching in headless Linux mode,
 * prepending missing native flags while preserving all existing CLI arguments.
 */
export function getHeadlessLinuxArgs(argv: readonly string[] = process.argv): string[] {
  const flagsToAdd = LINUX_HEADLESS_FLAGS.filter((flag) =>
    flag.startsWith('--ozone-platform=') ? !hasOzonePlatform(argv) : !argv.includes(flag)
  )

  return [...flagsToAdd, ...argv.slice(1)]
}

/**
 * If running on Linux in CLI or daemon mode without `--ozone-platform` on argv,
 * replace the process before Chromium initializes the selected display backend.
 * execve (provided by Electron's embedded Node 24) keeps the PID, standard I/O,
 * exit status and signal semantics intact. A spawnSync supervisor would block
 * signal handling and could leave an orphaned daemon when only its PID is stopped.
 */
export function relaunchForHeadlessLinux(): void {
  if (!shouldRelaunchForHeadlessLinux()) return

  try {
    if (!process.execve) throw new Error('This Electron runtime does not support process.execve')
    // execve needs argv[0], unlike child_process.spawn. Preserve the app path
    // for unpackaged launches and every user argument, including data-dir overrides.
    process.execve(process.execPath, [process.execPath, ...getHeadlessLinuxArgs()], process.env)
  } catch (error) {
    console.error('Failed to relaunch headless Kudu process:', error)
    process.exit(1)
  }
}
