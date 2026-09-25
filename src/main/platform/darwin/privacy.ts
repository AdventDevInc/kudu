import { execFile } from 'child_process'
import { access, constants, lstat, readFile, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { promisify } from 'util'
import {
  SYSCTL_HEADER,
  removeSysctlConfigParam,
  sshdDirective,
  sysctlAssignment,
  updateSshdConfig,
  updateSysctlConfig
} from '../config-utils'
import type { PlatformPrivacy, PrivacySettingDef } from '../types'
import type { PrivacyApplyResult } from '../../../shared/types'
import { clearPriorState, loadPriorState, savePriorState, type PriorState } from './privacy-state'

const execFileAsync = promisify(execFile)

function isRoot(): boolean {
  return process.getuid?.() === 0
}

export function createDarwinPrivacy(): PlatformPrivacy {
  const settings: DarwinPrivacySetting[] = [
    ...DARWIN_PRIVACY_SETTINGS,
    ...DARWIN_ADS_SETTINGS,
    ...DARWIN_SEARCH_SETTINGS,
    ...DARWIN_SYNC_SETTINGS,
    ...DARWIN_AI_SETTINGS,
    ...DARWIN_BROWSER_SETTINGS,
    ...DARWIN_KERNEL_SETTINGS,
    ...DARWIN_NETWORK_SETTINGS,
    ...DARWIN_ACCESS_SETTINGS
  ]
  return {
    getSettings(): PrivacySettingDef[] {
      return settings.map((setting) => ({
        ...setting,
        async apply() {
          await captureState(settings, setting)
          await setting.apply()
        },
        async revert() {
          const result = await revertSettings(settings, [setting.id])
          if (result.failed > 0) throw new Error(result.errors[0].reason)
        },
        canRevert: async () => !!resolvePriors(setting, await loadPriorState(setting.id))
      }))
    },
    revertSettings: (ids) => revertSettings(settings, ids)
  }
}

// ─── Elevated execution helper ──────────────────────────────
// When the Electron process is not root (common even with `sudo npm run dev`
// because npm/electron-vite can drop privileges), this uses osascript to
// show a native macOS password dialog — the same UX as System Settings.

function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'"
}

// Custom prompt shown in the macOS authentication dialog. Without this,
// macOS falls back to "osascript wants to make changes", which looks
// suspicious to non-technical users who don't recognize the binary name.
const ELEVATION_PROMPT =
  'Kudu needs your administrator password to apply system hardening settings.'

async function elevatedExec(cmd: string, args: string[]): Promise<string> {
  if (isRoot()) {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000 })
    return stdout
  }
  const escaped = [cmd, ...args].map(shellEscape).join(' ')
  const script = `do shell script ${JSON.stringify(escaped)} with prompt ${JSON.stringify(ELEVATION_PROMPT)} with administrator privileges`
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 30_000 })
  return stdout
}

/**
 * Run multiple commands in a single elevation prompt. Each command is joined
 * with `&&` so the batch stops on the first failure. This avoids showing
 * multiple macOS password dialogs when an apply needs more than one step.
 */
async function elevatedBatch(commands: Array<{ cmd: string; args: string[] }>): Promise<void> {
  if (isRoot()) {
    for (const { cmd, args } of commands) {
      await execFileAsync(cmd, args, { timeout: 10_000 })
    }
    return
  }
  const parts = commands.map(({ cmd, args }) => [cmd, ...args].map(shellEscape).join(' '))
  const combined = parts.join(' && ')
  const script = `do shell script ${JSON.stringify(combined)} with prompt ${JSON.stringify(ELEVATION_PROMPT)} with administrator privileges`
  await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 30_000 })
}

// A symlinked config file is usually maintained by configuration management;
// replacing the link (mv) would destroy it and writing through it would edit
// someone else's source of truth, so Kudu leaves such files alone entirely.
async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink())
      throw new Error(
        `${filePath} is a symbolic link, probably managed by configuration management. Kudu won't modify it; change the setting there instead.`
      )
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
}

// Moving a user-written temp file into place would make the user its owner,
// letting any unprivileged process rewrite sshd or kernel config. Always hand
// it to root:wheel — older Kudu builds left these files user-owned, so the
// current owner isn't worth keeping — but keep the mode it already has (a
// restrictive 0600 stays 0600) minus group/other write; a file Kudu creates
// gets 0644. Runs in the same elevation as the mv.
async function installFileCommands(tmp: string, filePath: string): Promise<Command[]> {
  await assertNotSymlink(filePath)
  let mode = '644'
  try {
    mode = ((await stat(filePath)).mode & 0o755).toString(8)
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
  return [
    { cmd: '/bin/mv', args: ['-f', tmp, filePath] },
    { cmd: '/usr/sbin/chown', args: ['root:wheel', filePath] },
    { cmd: '/bin/chmod', args: [mode, filePath] }
  ]
}

// Temp file then mv, as root or not, so both end with the same owner and mode
async function elevatedWriteFile(filePath: string, content: string): Promise<void> {
  const tmp = join(tmpdir(), `kudu-${randomUUID()}.tmp`)
  await writeFile(tmp, content, 'utf8')
  try {
    await elevatedBatch(await installFileCommands(tmp, filePath))
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

// ─── defaults helpers ───────────────────────────────────────

async function defaultsRead(domain: string, key: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/defaults', ['read', domain, key], {
    timeout: 5_000
  })
  return stdout.trim()
}

async function defaultsWrite(
  domain: string,
  key: string,
  type: string,
  value: string
): Promise<void> {
  await execFileAsync('/usr/bin/defaults', ['write', domain, key, `-${type}`, value], {
    timeout: 5_000
  })
}

async function elevatedDefaultsWrite(
  domain: string,
  key: string,
  type: string,
  value: string
): Promise<void> {
  await elevatedExec('/usr/bin/defaults', ['write', domain, key, `-${type}`, value])
}

async function elevatedDefaultsDelete(domain: string, key: string): Promise<void> {
  await elevatedExec('/usr/bin/defaults', ['delete', domain, key])
}

// ─── systemsetup helpers ────────────────────────────────────
// Note: there is deliberately no unprivileged `systemsetup -getX` helper.
// On modern macOS the tool refuses to run without root ("You need
// administrator access to run this tool"), so a check() built on it always
// reports "unprotected" — even right after a successful elevated apply, which
// the UI then surfaces as "try running as administrator". Read the underlying
// state (launchd / pmset) instead; see isLaunchdServiceEnabled below.

async function systemsetupSet(flag: string, ...args: string[]): Promise<void> {
  await elevatedExec('/usr/sbin/systemsetup', [flag, ...args])
}

// ─── launchd service state helper ───────────────────────────
// Reads launchd's system override table, which is readable without root.
// Falls back to probing the service's TCP port: launchd holds the listening
// socket whenever the service is enabled, so this works before any connection.

async function isLaunchdServiceEnabled(label: string, fallbackPort: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('/bin/launchctl', ['print-disabled', 'system'], {
      timeout: 5_000
    })
    // Newer macOS prints `=> enabled|disabled`; older prints `=> true|false`
    // (true = disabled, since this is the *disabled* table).
    const escaped = label.replace(/\./g, '\\.')
    const match = stdout.match(new RegExp(`"${escaped}"\\s*=>\\s*(enabled|disabled|true|false)`))
    if (match) return match[1] === 'enabled' || match[1] === 'false'
  } catch {
    /* fall through to port probe */
  }
  try {
    await execFileAsync('/usr/bin/nc', ['-z', '-w', '1', '127.0.0.1', String(fallbackPort)], {
      timeout: 5_000
    })
    return true
  } catch {
    return false
  }
}

// ─── socketfilterfw (Application Firewall) helpers ──────────

const SOCKETFILTERFW = '/usr/libexec/ApplicationFirewall/socketfilterfw'

async function socketfilterfwGet(flag: string): Promise<string> {
  const { stdout } = await execFileAsync(SOCKETFILTERFW, [flag], { timeout: 5_000 })
  return stdout.trim()
}

async function socketfilterfwSet(flag: string, value: string): Promise<void> {
  await elevatedExec(SOCKETFILTERFW, [flag, value])
}

// --setglobalstate starts/stops the ALF daemon itself so changes take effect
// immediately. Other socketfilterfw flags (--setstealthmode, --setallowsigned)
// only update the on-disk config — on macOS Sonoma+ the running daemon won't
// pick up the change until it is restarted.
async function restartAlf(): Promise<void> {
  await elevatedExec('/bin/launchctl', ['kickstart', '-k', 'system/com.apple.alf']).catch(() => {})
}

// ─── Sysctl helpers (macOS) ─────────────────────────────────

const SYSCTL_CONF = '/etc/sysctl.conf'
const SYSCTL_REVERT_NOTE = '# Delete this file and reboot to revert all changes'

async function sysctlGet(param: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', param], { timeout: 5_000 })
  return stdout.trim()
}

async function sysctlApply(param: string, value: string): Promise<void> {
  // Apply live first — fail fast if the kernel rejects the value
  await elevatedExec('/usr/sbin/sysctl', ['-w', `${param}=${value}`])

  // Persist to /etc/sysctl.conf (macOS uses a single file, not .d/)
  let existing = ''
  try {
    existing = await readFile(SYSCTL_CONF, 'utf8')
  } catch {
    /* file doesn't exist yet */
  }

  const updated = updateSysctlConfig(existing, param, value, '=', SYSCTL_REVERT_NOTE)

  await elevatedWriteFile(SYSCTL_CONF, updated)
}

// ─── App detection helper (for browser settings) ───────────
// Uses mdfind (Spotlight metadata) to locate apps by bundle identifier,
// so installs in ~/Applications, other volumes, or renamed bundles are found.

async function isBrowserInstalled(bundleId: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/mdfind',
      [`kMDItemCFBundleIdentifier == "${bundleId}"`],
      { timeout: 5_000 }
    )
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

// ─── SSH config helper (macOS) ──────────────────────────────

const SSHD_LABEL = 'com.openssh.sshd'

async function applySshdDirective(directive: string, value: string): Promise<void> {
  const content = await readFile('/etc/ssh/sshd_config', 'utf8')
  const updated = updateSshdConfig(content, directive, value)
  await elevatedWriteFile('/etc/ssh/sshd_config', updated)
  // Reload sshd via launchctl
  try {
    await elevatedExec('/bin/launchctl', ['kickstart', '-k', `system/${SSHD_LABEL}`])
  } catch {
    await elevatedExec('/bin/launchctl', ['stop', SSHD_LABEL]).catch(() => {})
  }
}

// systemsetup is the documented way, but on Ventura+ it needs Full Disk
// Access for the *calling* process — which the osascript elevation
// trampoline doesn't inherit — and can silently no-op. Follow up with the
// launchd calls it performs under the hood so the result is deterministic.
const SSHD_DISABLE_SCRIPT = [
  '/usr/sbin/systemsetup -f -setremotelogin off >/dev/null 2>&1 || true',
  `/bin/launchctl disable system/${SSHD_LABEL}`,
  `/bin/launchctl bootout system/${SSHD_LABEL} >/dev/null 2>&1 || true`
].join('; ')
const SSHD_ENABLE_SCRIPT = [
  '/usr/sbin/systemsetup -f -setremotelogin on >/dev/null 2>&1 || true',
  `/bin/launchctl enable system/${SSHD_LABEL} || exit 1`,
  // Fails harmlessly when the job is already loaded
  '/bin/launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist >/dev/null 2>&1 || true'
].join('; ')

// ─── Revert: capture and restore prior state ────────────────
// Each setting lists the pieces of system state its apply() changes. apply()
// first captures what they hold now (privacy-state.ts) and revert writes
// exactly that back — the user's own state, not an assumed default. Only when
// nothing was captured (applied by an older Kudu, or protected before Kudu
// touched it) does revert use a part's `fallback`: the macOS default, given
// only where that default is certain. Without one the setting stays
// non-reversible rather than guessing.
//
// Fallbacks in use:
//   - AirDrop DiscoverableMode, CrashReporter DialogType, Safari
//     UniversalSearchEnabled / PreloadTopHit / SendDoNotTrackHTTPHeader,
//     Spotlight LookupSuggestionsDisabled: key unset. macOS ships them unset,
//     and unset is the unprotected behaviour.
//   - Chrome / Firefox managed policies: no policy key (an unmanaged Mac has
//     none); the plist's mode is left as Kudu set it.
//   - Application Firewall off, stealth mode off, automatically allow built-in
//     and downloaded signed software on.
//   - kern.coredump=1 with no line in /etc/sysctl.conf.
// Everything else has none: its default comes from Setup Assistant choices
// (Siri, analytics, dictation), varies by hardware (wake on network), already
// is the protected state (Gatekeeper, guest account, remote login and Apple
// events, IP forwarding, keys the checks treat unset as protected), or can't
// be known (the auto-login user, which sshd_config lines were Kudu's).

interface Command {
  cmd: string
  args: string[]
  /** Failure is ignored (e.g. restarting a daemon that isn't running) */
  optional?: boolean
}

/** Rewrite a root-owned config file; `null` means the file is absent. */
interface FileEdit {
  path: string
  edit: (content: string | null) => string | null
}

type RestoreAction = Command | FileEdit

interface StatePart<S> {
  /** Key in the prior-state store; keep stable across releases */
  id: string
  /** `elevate: false` throws RootOnlyError instead of asking for a password */
  read: (options?: { elevate?: boolean }) => Promise<S>
  valid: (value: unknown) => value is S
  /** The state apply() leaves behind, given the state it started from */
  applied: (prior: S) => S
  /** Documented macOS default, used only when no prior state was captured */
  fallback?: S
  /** Without a capture, leave this part as it is rather than blocking revert */
  optional?: boolean
  /**
   * Several settings change this same state (a plist's mode, sysctl.conf's
   * existence). The user's original is carried across their captures.
   */
  shared?: boolean
  /**
   * Only the last sharing setting reverted restores it (e.g. a plist's mode,
   * so a policy still applied stays readable).
   */
  lastRevertOnly?: boolean
  /** Whether `current` counts as restored to `prior`; defaults to equality */
  restored?: (current: S, prior: S) => boolean
  /** `currentUnknown`: the current state couldn't be read without root */
  restore: (prior: S, currentUnknown?: boolean) => RestoreAction[]
}

/** A root-only file that can't be read without a password prompt of its own. */
class RootOnlyError extends Error {}

interface DarwinPrivacySetting extends PrivacySettingDef {
  state: StatePart<any>[]
}

const NOT_CAPTURED =
  "Kudu has no record of this setting's previous state and macOS's default isn't certain, so it can't be reverted safely. Change it in System Settings instead."

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

function errorText(error: unknown): string {
  const e = error as { message?: string; stderr?: string } | undefined
  return `${e?.message ?? ''}\n${e?.stderr ?? ''}`
}

async function captureState(
  settings: DarwinPrivacySetting[],
  setting: DarwinPrivacySetting
): Promise<void> {
  const earlier = await loadPriorState(setting.id)
  const prior: PriorState = {}
  let changes = false
  for (const part of setting.state) {
    let current: unknown
    try {
      current = await part.read()
    } catch (error) {
      throw new Error(
        `Kudu couldn't record the current state, so nothing was changed: ${error instanceof Error ? error.message : error}`,
        { cause: error }
      )
    }
    // An earlier capture still stands while the part holds exactly what Kudu
    // wrote (e.g. retrying a half-finished apply); anything else means the
    // user changed it since, so what's there now is theirs.
    const kept = earlier?.[part.id]
    let value = part.valid(kept) && same(current, part.applied(kept)) ? kept : current
    // Shared state already changed by another setting's apply: carry over the
    // user's original from that setting's capture
    if (part.shared && same(value, part.applied(value))) {
      for (const other of settings) {
        if (other === setting || !other.state.some((p) => p.id === part.id)) continue
        const theirs = (await loadPriorState(other.id))?.[part.id]
        if (part.valid(theirs) && !same(theirs, part.applied(theirs))) value = theirs
      }
    }
    prior[part.id] = value
    if (!same(value, part.applied(value))) changes = true
  }
  // Already in the applied state: there is nothing of the user's to put back,
  // so revert treats the setting as uncaptured.
  if (changes) await savePriorState(setting.id, prior)
  else await clearPriorState(setting.id)
}

function resolvePriors(
  setting: DarwinPrivacySetting,
  stored: PriorState | undefined
): PriorState | undefined {
  const priors: PriorState = {}
  for (const part of setting.state) {
    const value = stored?.[part.id]
    if (part.valid(value)) priors[part.id] = value
    else if (part.fallback !== undefined) priors[part.id] = part.fallback
    else if (!part.optional) return undefined
  }
  return priors
}

// Root config files (sysctl.conf, sshd_config); refuses symlinks up front so
// capture fails — and apply changes nothing — before any live change is made
async function readConfig(path: string): Promise<string | null> {
  await assertNotSymlink(path)
  try {
    return await readFile(path, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Run independent command groups behind one password prompt. Within a group
 * commands stop at the first failure (like elevatedBatch); each group reports
 * its own exit status, so one failed revert neither fails nor hides the rest.
 * Returns a failure reason per group (undefined = success).
 */
async function elevatedGroups(groups: Command[][]): Promise<(string | undefined)[]> {
  if (groups.length === 0) return []
  if (isRoot()) {
    const failures: (string | undefined)[] = []
    for (const group of groups) {
      try {
        for (const { cmd, args, optional } of group) {
          await execFileAsync(cmd, args, { timeout: 10_000 }).catch((error) => {
            if (!optional) throw error
          })
        }
        failures.push(undefined)
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'Unknown error')
      }
    }
    return failures
  }
  const script = groups
    .map((group, i) => {
      const chain = group
        .map(({ cmd, args, optional }) => {
          const line = [cmd, ...args].map(shellEscape).join(' ')
          return optional ? `{ ${line} || true; }` : line
        })
        .join(' && ')
      return `(${chain}) 1>&2; echo kudu-group:${i}:$?`
    })
    .join('; ')
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      '/usr/bin/osascript',
      [
        '-e',
        `do shell script ${JSON.stringify(script)} with prompt ${JSON.stringify(ELEVATION_PROMPT)} with administrator privileges`
      ],
      { timeout: 30_000 + groups.length * 10_000 }
    ))
  } catch (error) {
    // Cancelled or refused password: nothing ran
    const reason = error instanceof Error ? error.message : 'Unknown error'
    return groups.map(() => reason)
  }
  const status = new Map(
    [...stdout.matchAll(/kudu-group:(\d+):(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])])
  )
  return groups.map((_, i) =>
    status.get(i) === 0
      ? undefined
      : status.has(i)
        ? `The revert command failed (exit code ${status.get(i)})`
        : 'The revert command did not run'
  )
}

/**
 * Revert several settings together. User-level settings are restored
 * directly; every admin setting shares a single password prompt. A setting's
 * captured state is only forgotten once the system reads back as restored.
 */
async function revertSettings(
  settings: DarwinPrivacySetting[],
  ids: string[]
): Promise<PrivacyApplyResult> {
  const errors: PrivacyApplyResult['errors'] = []
  const fail = (setting: DarwinPrivacySetting, reason: unknown) =>
    errors.push({
      id: setting.id,
      label: setting.label,
      reason: reason instanceof Error ? reason.message : String(reason)
    })
  const ran: Array<{ setting: DarwinPrivacySetting; priors: PriorState }> = []
  const groups: Array<{ setting: DarwinPrivacySetting; priors: PriorState; commands: Command[] }> =
    []
  // Config files as this batch will leave them, so two edits to one file stack
  const files = new Map<string, string | null>()
  const temps: string[] = []
  // Parts only root can read back; their root command's exit status is the check
  const unverified = new Set<StatePart<any>>()

  for (const id of ids) {
    const setting = settings.find((s) => s.id === id)
    if (!setting) {
      errors.push({ id, label: id, reason: 'Revert not supported for this setting' })
      continue
    }
    try {
      const priors = resolvePriors(setting, await loadPriorState(setting.id))
      if (!priors) throw new Error(NOT_CAPTURED)
      for (const part of setting.state.filter((p) => p.lastRevertOnly && p.id in priors)) {
        for (const other of settings) {
          if (other === setting || !other.state.some((p) => p.id === part.id)) continue
          const at = ids.indexOf(other.id)
          // Reverted later in this batch, or still applied: leave it to them
          if (at > ids.indexOf(id) || (at < 0 && (await other.check().catch(() => false))))
            delete priors[part.id]
        }
      }
      const commands: Command[] = []
      const staged = new Map<string, string | null>()
      for (const part of setting.state) {
        if (!(part.id in priors)) continue
        const prior = priors[part.id]
        // Planning never prompts: a root-only plist can't be compared first, so
        // its restore runs unconditionally inside the shared elevated batch.
        let currentUnknown = false
        try {
          if (same(await part.read({ elevate: false }), prior)) continue
        } catch (error) {
          if (!(error instanceof RootOnlyError) || !setting.requiresAdmin) throw error
          currentUnknown = true
          unverified.add(part)
        }
        for (const action of part.restore(prior, currentUnknown)) {
          if ('cmd' in action) {
            commands.push(action)
            continue
          }
          const current = staged.has(action.path)
            ? (staged.get(action.path) as string | null)
            : files.has(action.path)
              ? (files.get(action.path) as string | null)
              : await readConfig(action.path)
          const next = action.edit(current)
          staged.set(action.path, next)
          if (next === null) {
            commands.push({ cmd: '/bin/rm', args: ['-f', action.path] })
          } else {
            const tmp = join(tmpdir(), `kudu-${randomUUID()}.tmp`)
            await writeFile(tmp, next, 'utf8')
            temps.push(tmp)
            commands.push(...(await installFileCommands(tmp, action.path)))
          }
        }
      }
      staged.forEach((content, path) => files.set(path, content))
      if (setting.requiresAdmin && commands.length > 0) {
        groups.push({ setting, priors, commands })
        continue
      }
      for (const { cmd, args, optional } of commands) {
        await execFileAsync(cmd, args, { timeout: 5_000 }).catch((error) => {
          if (!optional) throw error
        })
      }
      ran.push({ setting, priors })
    } catch (error) {
      fail(setting, error)
    }
  }

  const failures = await elevatedGroups(groups.map((g) => g.commands))
  groups.forEach((group, i) => {
    if (failures[i]) fail(group.setting, failures[i])
    else ran.push(group)
  })
  await Promise.all(temps.map((tmp) => unlink(tmp).catch(() => {})))

  let succeeded = 0
  for (const { setting, priors } of ran) {
    let restored = true
    for (const part of setting.state) {
      if (!(part.id in priors)) continue
      const prior = priors[part.id]
      restored &&= await part
        .read({ elevate: false })
        .then((value) => (part.restored ? part.restored(value, prior) : same(value, prior)))
        .catch((error) => error instanceof RootOnlyError && unverified.has(part))
    }
    if (!restored) {
      fail(
        setting,
        "macOS didn't report the previous state after reverting. Kudu kept its record so you can try again."
      )
      continue
    }
    await clearPriorState(setting.id).catch((error) =>
      console.warn('[privacy] could not clear prior state:', error)
    )
    succeeded++
  }
  return { succeeded, failed: errors.length, errors }
}

// ─── Revert: state parts ────────────────────────────────────

type DefaultsType = 'bool' | 'int' | 'float' | 'string'
type DefaultsValue = { type: DefaultsType; value: string } | null

const OFF: DefaultsValue = { type: 'bool', value: '0' }
const ON: DefaultsValue = { type: 'bool', value: '1' }

const DEFAULTS_FORMATS: Record<DefaultsType, (value: string) => boolean> = {
  bool: (v) => v === '0' || v === '1',
  int: (v) => /^-?\d{1,19}$/.test(v),
  float: (v) => /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(v),
  // Control characters can't round-trip through the elevation script
  string: (v) => v.length <= 4096 && ![...v].some((c) => c < ' ' || c === '\x7f')
}

function isDefaultsValue(value: unknown): value is DefaultsValue {
  if (value === null) return true
  const v = value as { type?: unknown; value?: unknown }
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.value === 'string' &&
    (['bool', 'int', 'float', 'string'] as unknown[]).includes(v.type) &&
    DEFAULTS_FORMATS[v.type as DefaultsType](v.value)
  )
}

// Only scalar types can be written back exactly with `defaults write -<type>`;
// anything else (arrays, dictionaries, dates, data) refuses the apply instead.
function checkedDefault(key: string, type: DefaultsType | undefined, value: string): DefaultsValue {
  const result = type ? { type, value } : undefined
  if (!isDefaultsValue(result)) throw new Error(`the current value of ${key} can't be restored`)
  return result
}

const DEFAULTS_TYPE_NAMES = new Map<string, DefaultsType>([
  ['boolean', 'bool'],
  ['integer', 'int'],
  ['float', 'float'],
  ['string', 'string']
])

async function readUserDefault(
  domain: string,
  key: string,
  currentHost: boolean
): Promise<DefaultsValue> {
  const host = currentHost ? ['-currentHost'] : []
  let typeName: string
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/defaults',
      [...host, 'read-type', domain, key],
      { timeout: 5_000 }
    )
    typeName = stdout.trim().replace(/^Type is /, '')
  } catch (error) {
    // "The domain/default pair of (…) does not exist" — anything else is not
    // proof of absence, so it fails the capture rather than recording "unset"
    if (/does not exist/i.test(errorText(error))) return null
    throw error
  }
  const type = DEFAULTS_TYPE_NAMES.get(typeName)
  if (!type) return checkedDefault(key, undefined, '')
  const { stdout } = await execFileAsync('/usr/bin/defaults', [...host, 'read', domain, key], {
    timeout: 5_000
  })
  return checkedDefault(key, type, type === 'string' ? stdout.replace(/\n$/, '') : stdout.trim())
}

const NO_PLIST_VALUE = /No value at that key path/i

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function parsePlistValue(key: string, xml: string): DefaultsValue {
  const body = xml.match(/<plist[^>]*>([\s\S]*)<\/plist>/)?.[1].trim() ?? ''
  if (body === '<true/>') return ON
  if (body === '<false/>') return OFF
  if (body === '<string/>') return checkedDefault(key, 'string', '')
  const match = body.match(/^<(integer|real|string)>([^<]*)<\/\1>$/)
  const types: Record<string, DefaultsType> = { integer: 'int', real: 'float', string: 'string' }
  return checkedDefault(key, match ? types[match[1]] : undefined, match ? decodeXml(match[2]) : '')
}

// System-wide domains are written by root's cfprefsd, so the user's cached view
// of them can be stale. Read the plist file itself, like managedPrefBool does.
async function readPlistDefault(
  domain: string,
  key: string,
  elevate: boolean
): Promise<DefaultsValue> {
  const file = `${domain}.plist`
  const args = ['-extract', key, 'xml1', '-o', '-', file]
  let rootOnly = false
  try {
    await access(file, constants.R_OK)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    if (error?.code !== 'EACCES') throw error
    rootOnly = true
  }
  let xml: string
  try {
    if (!rootOnly) xml = (await execFileAsync('/usr/bin/plutil', args, { timeout: 5_000 })).stdout
    // Root-only plist (cfprefsd creates new files 0600). Capture before apply
    // reads it as root; revert passes elevate: false to keep a single prompt.
    else if (elevate) xml = await elevatedExec('/usr/bin/plutil', args)
    else throw new RootOnlyError(`${file} is readable only by root`)
  } catch (error) {
    if (NO_PLIST_VALUE.test(errorText(error))) return null
    throw error
  }
  return parsePlistValue(key, xml)
}

// `defaults delete` fails when the key is already gone; only that case is fine
const DELETE_IF_PRESENT =
  'out=$(/usr/bin/defaults delete "$1" "$2" 2>&1) && exit 0; case "$out" in *"does not exist"*) exit 0 ;; esac; echo "$out" >&2; exit 1'

/**
 * A preference key. `applied` is what apply() writes (null = deletes it).
 * Absolute domains are system plists (restored as root); `managed` ones also
 * get the same mkdir/chmod that managedPrefWrite does.
 */
function prefPart(
  domain: string,
  key: string,
  applied: DefaultsValue,
  options: { currentHost?: boolean; managed?: boolean; fallback?: DefaultsValue } = {}
): StatePart<DefaultsValue> {
  const host = options.currentHost ? ['-currentHost'] : []
  return {
    id: `defaults:${options.currentHost ? 'currentHost:' : ''}${domain}:${key}`,
    read: ({ elevate = true } = {}) =>
      domain.startsWith('/')
        ? readPlistDefault(domain, key, elevate)
        : readUserDefault(domain, key, !!options.currentHost),
    valid: isDefaultsValue,
    applied: () => applied,
    fallback: options.fallback,
    restore(prior, currentUnknown) {
      // Unread (root-only) current state: the key may already be gone
      const write: Command =
        prior === null && currentUnknown
          ? { cmd: '/bin/sh', args: ['-c', DELETE_IF_PRESENT, 'sh', domain, key] }
          : {
              cmd: '/usr/bin/defaults',
              args:
                prior === null
                  ? [...host, 'delete', domain, key]
                  : [
                      ...host,
                      'write',
                      domain,
                      key,
                      `-${prior.type}`,
                      prior.type === 'bool' ? (prior.value === '1' ? 'true' : 'false') : prior.value
                    ]
            }
      if (!options.managed) return [write]
      return [
        { cmd: '/bin/mkdir', args: ['-p', MANAGED_PREFS] },
        write,
        { cmd: '/bin/chmod', args: ['644', `${domain}.plist`] }
      ]
    }
  }
}

// Removes the plist only while it holds no keys at all; anything else stays
const REMOVE_IF_EMPTY =
  '[ "$(/usr/bin/plutil -convert json -o - "$1" 2>/dev/null)" = "{}" ] && /bin/rm -f "$1"; exit 0'

/**
 * A managed-preferences plist's existence and mode. managedPrefWrite creates
 * it if needed and makes it 0644 so the policy is readable; revert puts back
 * the mode the user had (e.g. 0600, which keeps other policies private), or
 * removes a plist Kudu created once it is empty again. Without a capture the
 * file is left as it is.
 */
function managedPlistPart(domain: string): StatePart<{ mode: string } | null> {
  const file = `${MANAGED_PREFS}/${domain}.plist`
  return {
    id: `plist-mode:${file}`,
    async read() {
      try {
        return { mode: ((await stat(file)).mode & 0o777).toString(8).padStart(3, '0') }
      } catch (error: any) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
    },
    valid: (v): v is { mode: string } | null =>
      v === null ||
      (!!v &&
        typeof v === 'object' &&
        typeof (v as { mode?: unknown }).mode === 'string' &&
        /^[0-7]{3}$/.test((v as { mode: string }).mode)),
    applied: () => ({ mode: '644' }),
    optional: true,
    shared: true,
    lastRevertOnly: true,
    // A plist Kudu created may still hold someone else's policies; then it stays
    restored: (current, prior) => prior === null || same(current, prior),
    restore: (prior) => [
      prior === null
        ? { cmd: '/bin/sh', args: ['-c', REMOVE_IF_EMPTY, 'sh', file] }
        : { cmd: '/bin/chmod', args: [prior.mode, file] }
    ]
  }
}

// The line updateSysctlConfig replaces: the first assignment, in any spacing
function sysctlLine(content: string | null, param: string): string | null {
  const assignment = sysctlAssignment(param)
  return content?.split('\n').find((line) => assignment.test(line)) ?? null
}

// Put back the line updateSysctlConfig replaced (or drop the one it added),
// leaving every other line alone
function restoreSysctlLine(content: string | null, param: string, prior: string | null) {
  if (prior === null) return removeSysctlConfigParam(content ?? '', param)
  const lines = (content ?? '').split('\n')
  const current = sysctlLine(content, param)
  if (current !== null) {
    lines[lines.indexOf(current)] = prior
    return lines.join('\n')
  }
  const rest = (content ?? '').trimEnd()
  return (rest ? rest + '\n' : '') + prior + '\n'
}

/**
 * A sysctl set by sysctlApply: the live kernel value and its line in
 * /etc/sysctl.conf. `fallback` is the documented kernel default, if certain.
 */
function sysctlParts(param: string, value: string, fallback?: string): StatePart<any>[] {
  const live: StatePart<string> = {
    id: `sysctl:${param}`,
    read: () => sysctlGet(param),
    valid: (v): v is string => typeof v === 'string' && /^-?\d{1,19}$/.test(v),
    applied: () => value,
    fallback,
    restore: (prior) => [{ cmd: '/usr/sbin/sysctl', args: ['-w', `${param}=${prior}`] }]
  }
  const conf: StatePart<string | null> = {
    id: `sysctl.conf:${param}`,
    read: async () => sysctlLine(await readConfig(SYSCTL_CONF), param),
    valid: (v): v is string | null =>
      v === null || (typeof v === 'string' && !v.includes('\n') && sysctlLine(v, param) === v),
    applied: () => `${param}=${value}`,
    // With the kernel default restored, Kudu's line is simply dropped
    fallback: fallback === undefined ? undefined : null,
    restore: (prior) => [
      { path: SYSCTL_CONF, edit: (content) => restoreSysctlLine(content, param, prior) }
    ]
  }
  return [live, conf, sysctlFilePart]
}

// Whether /etc/sysctl.conf existed, and its exact text if it was blank —
// updateSysctlConfig writes Kudu's header into a missing or blank file. Once
// only that header is left, revert deletes a file Kudu created or puts the
// blank text back; a file that has gained other lines stays. Without a
// capture the file is left alone.
type SysctlFileState = null | string | true // absent | blank text | has content
const sysctlFilePart: StatePart<SysctlFileState> = {
  id: 'sysctl.conf:file',
  async read() {
    const content = await readConfig(SYSCTL_CONF)
    if (content === null) return null
    return content.trim() === '' ? content : true
  },
  valid: (v): v is SysctlFileState =>
    v === null || v === true || (typeof v === 'string' && v.length <= 4096 && v.trim() === ''),
  applied: () => true,
  optional: true,
  shared: true,
  restored: (current, prior) => current === true || same(current, prior),
  restore: (prior) =>
    prior === true
      ? []
      : [
          {
            path: SYSCTL_CONF,
            edit: (content) => {
              const rest = content?.trim() ?? ''
              const onlyKudu =
                rest === '' || rest === [...SYSCTL_HEADER, SYSCTL_REVERT_NOTE].join('\n')
              return onlyKudu ? prior : content
            }
          }
        ]
}

const SSHD_CONFIG = '/etc/ssh/sshd_config'

// Same lines updateSshdConfig matches, in file order
function sshdLines(content: string, directive: string): string[] {
  const pattern = sshdDirective(directive)
  return content.split('\n').filter((line) => pattern.test(line))
}

/**
 * An sshd_config directive set by applySshdDirective. The prior state is every
 * line for the directive (active or commented). Revert maps them back one to
 * one — undoing the commenting-out and dropping the appended line — but only
 * while those lines are exactly as Kudu left them; otherwise it refuses
 * rather than overwrite someone else's edit. No fallback: without a capture
 * there's no telling which lines were Kudu's.
 */
function sshdPart(directive: string, value: string): StatePart<string[]> {
  const applied = (prior: string[]) =>
    sshdLines(updateSshdConfig(prior.join('\n'), directive, value), directive)
  return {
    id: `sshd_config:${directive}`,
    async read() {
      const content = await readConfig(SSHD_CONFIG)
      if (content === null) throw new Error(`${SSHD_CONFIG} is missing`)
      return sshdLines(content, directive)
    },
    valid: (v): v is string[] =>
      Array.isArray(v) &&
      v.length <= 100 &&
      v.every((line) => typeof line === 'string' && sshdLines(line, directive).length === 1),
    applied,
    restore: (prior) => [
      {
        path: SSHD_CONFIG,
        edit(content) {
          const lines = (content ?? '').split('\n')
          const at = lines.flatMap((line, i) => (sshdLines(line, directive).length ? [i] : []))
          const expected = applied(prior)
          if (
            content === null ||
            !same(
              at.map((i) => lines[i]),
              expected
            )
          )
            throw new Error(
              `${SSHD_CONFIG} was edited after Kudu changed it, so Kudu won't overwrite it. Restore ${directive} by hand.`
            )
          prior.forEach((line, n) => (lines[at[n]] = line))
          if (expected.length > prior.length) lines.splice(at[at.length - 1], 1)
          return lines.join('\n')
        }
      },
      { cmd: '/bin/launchctl', args: ['kickstart', '-k', `system/${SSHD_LABEL}`], optional: true }
    ]
  }
}

function launchdPart(
  label: string,
  port: number,
  restore: (enabled: boolean) => Command
): StatePart<boolean> {
  return {
    id: `launchd:${label}`,
    read: () => isLaunchdServiceEnabled(label, port),
    valid: isBoolean,
    applied: () => false,
    restore: (prior) => [restore(prior)]
  }
}

const ALF_RESTART: Command = {
  cmd: '/bin/launchctl',
  args: ['kickstart', '-k', 'system/com.apple.alf'],
  optional: true
}

function parseOnOff(output: string): boolean {
  if (/\b(disabled|off)\b/i.test(output)) return false
  if (/\b(enabled|on)\b/i.test(output)) return true
  throw new Error(`unrecognised firewall output: ${output}`)
}

// 0 = off, 1 = on, 2 = block all incoming connections
const firewallPart: StatePart<number> = {
  id: 'alf:globalstate',
  async read() {
    const out = await socketfilterfwGet('--getglobalstate')
    const state = out.match(/State = ([012])/)
    return state ? Number(state[1]) : parseOnOff(out) ? 1 : 0
  },
  valid: (v): v is number => v === 0 || v === 1 || v === 2,
  applied: () => 1,
  fallback: 0, // The Application Firewall ships turned off
  restore: (prior) =>
    prior === 0
      ? [{ cmd: SOCKETFILTERFW, args: ['--setglobalstate', 'off'] }]
      : [
          { cmd: SOCKETFILTERFW, args: ['--setglobalstate', 'on'] },
          { cmd: SOCKETFILTERFW, args: ['--setblockall', prior === 2 ? 'on' : 'off'] }
        ]
}

const stealthPart: StatePart<boolean> = {
  id: 'alf:stealthmode',
  read: async () => parseOnOff(await socketfilterfwGet('--getstealthmode')),
  valid: isBoolean,
  applied: () => true,
  fallback: false, // Stealth mode ships turned off
  restore: (prior) => [
    { cmd: SOCKETFILTERFW, args: ['--setstealthmode', prior ? 'on' : 'off'] },
    ALF_RESTART
  ]
}

// --getallowsigned prints one line per flag: built-in (--setallowsigned) and
// downloaded (--setallowsignedapp) signed software. Both ship enabled.
function allowSignedPart(flag: string, line: RegExp): StatePart<boolean> {
  return {
    id: `alf:${flag.replace(/^--set/, '')}`,
    async read() {
      const out = await socketfilterfwGet('--getallowsigned')
      const match = out.split('\n').find((l) => line.test(l))
      if (!match) throw new Error(`unrecognised firewall output: ${out}`)
      return parseOnOff(match)
    },
    valid: isBoolean,
    applied: () => false,
    fallback: true,
    restore: (prior) => [{ cmd: SOCKETFILTERFW, args: [flag, prior ? 'on' : 'off'] }, ALF_RESTART]
  }
}

const gatekeeperPart: StatePart<boolean> = {
  id: 'spctl:assessments',
  async read() {
    let out: string
    try {
      const { stdout, stderr } = await execFileAsync('/usr/sbin/spctl', ['--status'], {
        timeout: 5_000
      })
      out = stdout + stderr
    } catch (error) {
      // Some releases exit non-zero when assessments are disabled
      const e = error as { stdout?: string; stderr?: string }
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    }
    if (out.includes('assessments enabled')) return true
    if (out.includes('assessments disabled')) return false
    throw new Error('Gatekeeper status is unavailable')
  },
  valid: isBoolean,
  applied: () => true,
  restore: (prior) => [
    { cmd: '/usr/sbin/spctl', args: [prior ? '--master-enable' : '--master-disable'] }
  ]
}

// Wake-on-network per power source (pmset flag), as `pmset -g custom` lists it
type WompState = Record<string, '0' | '1'>
const PMSET_SOURCES: Record<string, string> = {
  'Battery Power': '-b',
  'AC Power': '-c',
  'UPS Power': '-u'
}

const wompPart: StatePart<WompState> = {
  id: 'pmset:womp',
  async read() {
    const { stdout } = await execFileAsync('/usr/bin/pmset', ['-g', 'custom'], { timeout: 5_000 })
    const state: WompState = {}
    let source: string | undefined
    for (const line of stdout.split('\n')) {
      const header = line.match(/^(\w+ Power):\s*$/)
      if (header) source = PMSET_SOURCES[header[1]]
      const womp = line.match(/^\s*womp\s+([01])\s*$/)
      if (womp && source) state[source] = womp[1] as '0' | '1'
    }
    return state
  },
  valid: (v): v is WompState =>
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.entries(v).every(
      ([source, value]) =>
        Object.values(PMSET_SOURCES).includes(source) && (value === '0' || value === '1')
    ),
  applied: (prior) => Object.fromEntries(Object.keys(prior).map((source) => [source, '0'])),
  restore: (prior) =>
    Object.entries(prior).map(([source, value]) => ({
      cmd: '/usr/bin/pmset',
      args: [source, 'womp', value]
    }))
}

const DARWIN_PRIVACY_SETTINGS: DarwinPrivacySetting[] = [
  {
    id: 'macos-diagnostics',
    category: 'telemetry',
    label: 'Diagnostic & Usage Data',
    description: 'Disable sharing diagnostic and usage data with Apple',
    requiresAdmin: true,
    state: [
      prefPart(
        '/Library/Application Support/CrashReporter/DiagnosticMessagesHistory',
        'AutoSubmit',
        OFF
      )
    ],
    async check() {
      try {
        const val = await defaultsRead(
          '/Library/Application Support/CrashReporter/DiagnosticMessagesHistory',
          'AutoSubmit'
        )
        return val === '0'
      } catch {
        return false
      }
    },
    async apply() {
      await elevatedDefaultsWrite(
        '/Library/Application Support/CrashReporter/DiagnosticMessagesHistory',
        'AutoSubmit',
        'bool',
        'false'
      )
    }
  },
  {
    id: 'macos-siri-analytics',
    category: 'telemetry',
    label: 'Siri Analytics',
    description: 'Disable Siri analytics and improvement data collection',
    requiresAdmin: false,
    state: [
      prefPart('com.apple.assistant.support', 'Siri Data Sharing Opt-In Status', {
        type: 'int',
        value: '2'
      })
    ],
    async check() {
      try {
        const val = await defaultsRead(
          'com.apple.assistant.support',
          'Siri Data Sharing Opt-In Status'
        )
        return val === '2' // 2 = opted out
      } catch {
        return false
      }
    },
    async apply() {
      await defaultsWrite(
        'com.apple.assistant.support',
        'Siri Data Sharing Opt-In Status',
        'int',
        '2'
      )
    }
  },
  {
    id: 'macos-health-data-sharing',
    category: 'telemetry',
    label: 'Health Data Sharing',
    description: 'Disable sharing health data with Apple for research',
    requiresAdmin: false,
    state: [prefPart('com.apple.HealthKit', 'ResearchDataSharingEnabled', OFF)],
    async check() {
      try {
        const val = await defaultsRead('com.apple.HealthKit', 'ResearchDataSharingEnabled')
        return val === '0'
      } catch {
        // Key doesn't exist = not sharing = privacy-friendly
        return true
      }
    },
    async apply() {
      await defaultsWrite('com.apple.HealthKit', 'ResearchDataSharingEnabled', 'bool', 'false')
    }
  },
  {
    id: 'macos-airdrop-discoverability',
    category: 'services',
    label: 'AirDrop Discoverability',
    description:
      'Set AirDrop to "No One" — you will not be able to receive files via AirDrop until re-enabled in System Settings',
    requiresAdmin: false,
    state: [
      prefPart(
        'com.apple.sharingd',
        'DiscoverableMode',
        { type: 'string', value: 'Off' },
        { fallback: null }
      )
    ],
    async check() {
      try {
        const val = await defaultsRead('com.apple.sharingd', 'DiscoverableMode')
        return val === 'Off'
      } catch {
        return false
      }
    },
    async apply() {
      await defaultsWrite('com.apple.sharingd', 'DiscoverableMode', 'string', 'Off')
    }
  },
  {
    id: 'macos-crash-reporter',
    category: 'telemetry',
    label: 'Crash Reporter',
    description: 'Set crash reporter to not send reports automatically',
    requiresAdmin: false,
    state: [
      prefPart(
        'com.apple.CrashReporter',
        'DialogType',
        { type: 'string', value: 'none' },
        { fallback: null }
      )
    ],
    async check() {
      try {
        const val = await defaultsRead('com.apple.CrashReporter', 'DialogType')
        return val === 'none'
      } catch {
        return false
      }
    },
    async apply() {
      await defaultsWrite('com.apple.CrashReporter', 'DialogType', 'string', 'none')
    }
  }
]

// ─── Ads & Suggestions ──────────────────────────────────────

const DARWIN_ADS_SETTINGS: DarwinPrivacySetting[] = [
  {
    id: 'macos-ad-tracking',
    category: 'ads',
    label: 'Personalized Ads',
    description: 'Limit ad tracking by Apple',
    requiresAdmin: false,
    state: [prefPart('com.apple.AdLib', 'allowApplePersonalizedAdvertising', OFF)],
    async check() {
      try {
        const val = await defaultsRead('com.apple.AdLib', 'allowApplePersonalizedAdvertising')
        return val === '0'
      } catch {
        return false
      }
    },
    async apply() {
      await defaultsWrite('com.apple.AdLib', 'allowApplePersonalizedAdvertising', 'bool', 'false')
    }
  },
  {
    id: 'macos-siri-suggestions-appstore',
    category: 'ads',
    label: 'Siri Suggestions in App Store',
    description: 'Disable Siri Suggestions in the App Store',
    requiresAdmin: false,
    state: [prefPart('com.apple.AppStore', 'SiriSuggestionsEnabled', OFF)],
    async check() {
      try {
        const val = await defaultsRead('com.apple.AppStore', 'SiriSuggestionsEnabled')
        return val === '0'
      } catch {
        return false
      }
    },
    async apply() {
      await defaultsWrite('com.apple.AppStore', 'SiriSuggestionsEnabled', 'bool', 'false')
    }
  }
]

// ─── Search ─────────────────────────────────────────────────

const DARWIN_SEARCH_SETTINGS: DarwinPrivacySetting[] = [
  {
    id: 'macos-safari-suggestions',
    category: 'search',
    label: 'Safari Suggestions',
    description: 'Disable Safari search suggestions sent to Apple',
    requiresAdmin: false,
    state: [prefPart('com.apple.Safari', 'UniversalSearchEnabled', OFF, { fallback: null })],
    async check() {
      try {
        const val = await defaultsRead('com.apple.Safari', 'UniversalSearchEnabled')
        return val === '0'
      } catch {
        return false
      }
    },
    async apply() {
      await defaultsWrite('com.apple.Safari', 'UniversalSearchEnabled', 'bool', 'false')
    }
  },
  {
    id: 'macos-spotlight-suggestions',
    category: 'search',
    label: 'Spotlight Suggestions',
    description: 'Disable Spotlight web suggestions',
    requiresAdmin: false,
    state: [
      prefPart('com.apple.lookup.shared', 'LookupSuggestionsDisabled', ON, { fallback: null })
    ],
    async check() {
      try {
        const val = await defaultsRead('com.apple.lookup.shared', 'LookupSuggestionsDisabled')
        return val === '1'
      } catch {
        return false
      }
    },
    async apply() {
      await defaultsWrite('com.apple.lookup.shared', 'LookupSuggestionsDisabled', 'bool', 'true')
    }
  },
  {
    id: 'macos-safari-preload-top-hit',
    category: 'search',
    label: 'Safari Preload Top Hit',
    description: 'Disable Safari preloading the top search hit which sends browsing data to sites',
    requiresAdmin: false,
    state: [prefPart('com.apple.Safari', 'PreloadTopHit', OFF, { fallback: null })],
    async check() {
      try {
        const val = await defaultsRead('com.apple.Safari', 'PreloadTopHit')
        return val === '0'
      } catch {
        return false
      }
    },
    async apply() {
      await defaultsWrite('com.apple.Safari', 'PreloadTopHit', 'bool', 'false')
    }
  }
]

// ─── Sync & Cloud ───────────────────────────────────────────

const DARWIN_SYNC_SETTINGS: DarwinPrivacySetting[] = [
  {
    id: 'macos-handoff',
    category: 'sync',
    label: 'Handoff',
    description:
      'Disable Handoff and Universal Clipboard — you will no longer be able to continue activities or copy/paste between Apple devices',
    requiresAdmin: false,
    state: [
      prefPart('com.apple.coreservices.useractivityd', 'ActivityReceivingAllowed', OFF, {
        currentHost: true
      })
    ],
    async check() {
      try {
        const { stdout } = await execFileAsync(
          '/usr/bin/defaults',
          [
            '-currentHost',
            'read',
            'com.apple.coreservices.useractivityd',
            'ActivityReceivingAllowed'
          ],
          { timeout: 5_000 }
        )
        return stdout.trim() === '0'
      } catch {
        return false
      }
    },
    async apply() {
      await execFileAsync(
        '/usr/bin/defaults',
        [
          '-currentHost',
          'write',
          'com.apple.coreservices.useractivityd',
          'ActivityReceivingAllowed',
          '-bool',
          'false'
        ],
        { timeout: 5_000 }
      )
    }
  },
  {
    id: 'macos-icloud-analytics',
    category: 'sync',
    label: 'iCloud Analytics',
    description: 'Disable iCloud analytics sharing with Apple',
    requiresAdmin: false,
    state: [prefPart('com.apple.iCloud.Diagnostics', 'iCloudAnalyticsEnabled', OFF)],
    async check() {
      try {
        const val = await defaultsRead('com.apple.iCloud.Diagnostics', 'iCloudAnalyticsEnabled')
        return val === '0'
      } catch {
        // Key doesn't exist = not sharing = privacy-friendly
        return true
      }
    },
    async apply() {
      await defaultsWrite('com.apple.iCloud.Diagnostics', 'iCloudAnalyticsEnabled', 'bool', 'false')
    }
  },
  {
    id: 'macos-safari-cloud-tabs',
    category: 'sync',
    label: 'Safari iCloud Tabs',
    description:
      'Disable Safari iCloud tab syncing — you will no longer see tabs open on your other Apple devices',
    requiresAdmin: false,
    state: [prefPart('com.apple.Safari', 'CloudTabsEnabled', OFF)],
    async check() {
      try {
        const val = await defaultsRead('com.apple.Safari', 'CloudTabsEnabled')
        return val === '0'
      } catch {
        return false
      }
    },
    async apply() {
      await defaultsWrite('com.apple.Safari', 'CloudTabsEnabled', 'bool', 'false')
    }
  }
]

// ─── AI Features ────────────────────────────────────────────

const DARWIN_AI_SETTINGS: DarwinPrivacySetting[] = [
  {
    id: 'macos-siri-enabled',
    category: 'ai',
    label: 'Siri',
    description:
      'Disable Siri entirely — Hey Siri, voice commands, and Siri Shortcuts will stop working',
    requiresAdmin: false,
    state: [prefPart('com.apple.assistant.support', 'Assistant Enabled', OFF)],
    async check() {
      try {
        const val = await defaultsRead('com.apple.assistant.support', 'Assistant Enabled')
        return val === '0'
      } catch {
        return false
      }
    },
    async apply() {
      await defaultsWrite('com.apple.assistant.support', 'Assistant Enabled', 'bool', 'false')
    }
  },
  {
    id: 'macos-siri-dictation',
    category: 'ai',
    label: 'Siri Dictation',
    description: 'Disable dictation — the microphone key on your keyboard will stop working',
    requiresAdmin: false,
    state: [
      prefPart(
        'com.apple.speech.recognition.AppleSpeechRecognition.prefs',
        'DictationIMMEnabled',
        OFF
      )
    ],
    async check() {
      try {
        const val = await defaultsRead(
          'com.apple.speech.recognition.AppleSpeechRecognition.prefs',
          'DictationIMMEnabled'
        )
        return val === '0'
      } catch {
        return false
      }
    },
    async apply() {
      await defaultsWrite(
        'com.apple.speech.recognition.AppleSpeechRecognition.prefs',
        'DictationIMMEnabled',
        'bool',
        'false'
      )
    }
  },
  {
    id: 'macos-apple-intelligence',
    category: 'ai',
    label: 'Apple Intelligence',
    description: 'Disable Apple Intelligence AI features (macOS 15 Sequoia and later)',
    requiresAdmin: false,
    state: [prefPart('com.apple.assistant.support', 'Apple Intelligence Enabled', OFF)],
    async check() {
      try {
        const val = await defaultsRead('com.apple.assistant.support', 'Apple Intelligence Enabled')
        return val === '0'
      } catch {
        // Key doesn't exist = feature not available = privacy-friendly
        return true
      }
    },
    async apply() {
      await defaultsWrite(
        'com.apple.assistant.support',
        'Apple Intelligence Enabled',
        'bool',
        'false'
      )
    }
  }
]

// ─── Browser Telemetry ──────────────────────────────────────

const CHROME_BUNDLE_ID = 'com.google.Chrome'
const FIREFOX_BUNDLE_ID = 'org.mozilla.firefox'
const MANAGED_PREFS = '/Library/Managed Preferences'

// Write a managed-preference policy key as root in a single elevation prompt.
// cfprefsd creates the plist owner-only (0600), so neither the browser (running
// as the user) nor our unprivileged check() can read it back — the toggle then
// looks like it "didn't take" even though the password was accepted. Explicitly
// chmod 644 so the policy is actually visible.
async function managedPrefWrite(
  domain: string,
  key: string,
  type: string,
  value: string
): Promise<void> {
  await elevatedBatch([
    { cmd: '/bin/mkdir', args: ['-p', MANAGED_PREFS] },
    {
      cmd: '/usr/bin/defaults',
      args: ['write', `${MANAGED_PREFS}/${domain}`, key, `-${type}`, value]
    },
    { cmd: '/bin/chmod', args: ['644', `${MANAGED_PREFS}/${domain}.plist`] }
  ])
}

// Read a boolean policy key back. Prefer plutil, which reads the file
// directly and so isn't affected by the user cfprefsd's cached view of a file
// root just replaced; fall back to `defaults read` for older macOS.
// Returns null when the key/file is absent or unreadable.
async function managedPrefBool(domain: string, key: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/plutil',
      ['-extract', key, 'raw', '-o', '-', `${MANAGED_PREFS}/${domain}.plist`],
      { timeout: 5_000 }
    )
    const val = stdout.trim()
    if (val === 'true' || val === '1') return true
    if (val === 'false' || val === '0') return false
  } catch {
    /* fall through */
  }
  try {
    const val = await defaultsRead(`${MANAGED_PREFS}/${domain}`, key)
    if (val === '1') return true
    if (val === '0') return false
  } catch {
    /* absent or unreadable */
  }
  return null
}

const DARWIN_BROWSER_SETTINGS: DarwinPrivacySetting[] = [
  {
    id: 'macos-safari-dnt',
    category: 'browser',
    label: 'Safari Do Not Track',
    description: 'Enable the Do Not Track header in Safari',
    requiresAdmin: false,
    state: [prefPart('com.apple.Safari', 'SendDoNotTrackHTTPHeader', ON, { fallback: null })],
    async check() {
      try {
        const val = await defaultsRead('com.apple.Safari', 'SendDoNotTrackHTTPHeader')
        return val === '1'
      } catch {
        return false
      }
    },
    async apply() {
      await defaultsWrite('com.apple.Safari', 'SendDoNotTrackHTTPHeader', 'bool', 'true')
    }
  },
  {
    id: 'macos-chrome-metrics',
    category: 'browser',
    label: 'Chrome Metrics Reporting',
    description: 'Stop Chrome from sending usage metrics to Google',
    requiresAdmin: true,
    state: [
      prefPart(`${MANAGED_PREFS}/com.google.Chrome`, 'MetricsReportingEnabled', OFF, {
        managed: true,
        fallback: null
      }),
      managedPlistPart('com.google.Chrome')
    ],
    applicable: () => isBrowserInstalled(CHROME_BUNDLE_ID),
    async check() {
      if (!(await isBrowserInstalled(CHROME_BUNDLE_ID))) return true
      return (await managedPrefBool('com.google.Chrome', 'MetricsReportingEnabled')) === false
    },
    async apply() {
      await managedPrefWrite('com.google.Chrome', 'MetricsReportingEnabled', 'bool', 'false')
    }
  },
  {
    id: 'macos-chrome-safe-browsing',
    category: 'browser',
    label: 'Chrome Safe Browsing Reports',
    description: 'Stop Chrome from sending extended URL and download reports to Google',
    requiresAdmin: true,
    state: [
      prefPart(`${MANAGED_PREFS}/com.google.Chrome`, 'SafeBrowsingExtendedReportingEnabled', OFF, {
        managed: true,
        fallback: null
      }),
      managedPlistPart('com.google.Chrome')
    ],
    applicable: () => isBrowserInstalled(CHROME_BUNDLE_ID),
    async check() {
      if (!(await isBrowserInstalled(CHROME_BUNDLE_ID))) return true
      return (
        (await managedPrefBool('com.google.Chrome', 'SafeBrowsingExtendedReportingEnabled')) ===
        false
      )
    },
    async apply() {
      await managedPrefWrite(
        'com.google.Chrome',
        'SafeBrowsingExtendedReportingEnabled',
        'bool',
        'false'
      )
    }
  },
  {
    id: 'macos-firefox-telemetry',
    category: 'browser',
    label: 'Firefox Telemetry',
    description: 'Disable Firefox telemetry data collection and upload to Mozilla',
    requiresAdmin: true,
    state: [
      prefPart(`${MANAGED_PREFS}/org.mozilla.firefox`, 'DisableTelemetry', ON, {
        managed: true,
        fallback: null
      }),
      managedPlistPart('org.mozilla.firefox')
    ],
    applicable: () => isBrowserInstalled(FIREFOX_BUNDLE_ID),
    async check() {
      if (!(await isBrowserInstalled(FIREFOX_BUNDLE_ID))) return true
      return (await managedPrefBool('org.mozilla.firefox', 'DisableTelemetry')) === true
    },
    async apply() {
      await managedPrefWrite('org.mozilla.firefox', 'DisableTelemetry', 'bool', 'true')
    }
  }
]

// ─── Kernel / System Hardening ──────────────────────────────

const DARWIN_KERNEL_SETTINGS: DarwinPrivacySetting[] = [
  {
    id: 'macos-gatekeeper',
    category: 'kernel',
    label: 'Gatekeeper',
    description: 'Ensure Gatekeeper is enabled to block unverified applications',
    requiresAdmin: true,
    state: [gatekeeperPart],
    async check() {
      try {
        const { stdout, stderr } = await execFileAsync('/usr/sbin/spctl', ['--status'], {
          timeout: 5_000
        })
        const out = (stdout + stderr).trim()
        return out.includes('assessments enabled')
      } catch {
        return false
      }
    },
    async apply() {
      await elevatedExec('/usr/sbin/spctl', ['--master-enable'])
    }
  },
  {
    id: 'macos-remote-apple-events',
    category: 'kernel',
    label: 'Remote Apple Events',
    description: 'Disable remote Apple Events to prevent remote automation of your Mac',
    requiresAdmin: true,
    state: [
      launchdPart('com.apple.AEServer', 3031, (enabled) => ({
        cmd: '/usr/sbin/systemsetup',
        args: ['-setremoteappleevents', enabled ? 'on' : 'off']
      }))
    ],
    async check() {
      // Remote Apple Events is the com.apple.AEServer launchd job (eppc, port 3031)
      return !(await isLaunchdServiceEnabled('com.apple.AEServer', 3031))
    },
    async apply() {
      await systemsetupSet('-setremoteappleevents', 'off')
    }
  },
  {
    id: 'macos-wake-on-network',
    category: 'kernel',
    label: 'Wake on Network Access',
    description: 'Disable wake on network access to prevent remote wake-ups',
    requiresAdmin: true,
    state: [wompPart],
    async check() {
      // `pmset -g` is readable without root; `womp` is the Wake-on-LAN flag
      try {
        const { stdout } = await execFileAsync('/usr/bin/pmset', ['-g'], { timeout: 5_000 })
        const match = stdout.match(/^\s*womp\s+(\d)/m)
        // No womp entry = hardware has no wake-on-network support = nothing to disable
        return match == null || match[1] === '0'
      } catch {
        return false
      }
    },
    async apply() {
      await systemsetupSet('-setwakeonnetworkaccess', 'off')
    }
  },
  {
    id: 'macos-guest-account',
    category: 'kernel',
    label: 'Guest Account',
    description: 'Disable the guest account to prevent unauthorized local access',
    requiresAdmin: true,
    state: [prefPart('/Library/Preferences/com.apple.loginwindow', 'GuestEnabled', OFF)],
    async check() {
      try {
        const val = await defaultsRead('/Library/Preferences/com.apple.loginwindow', 'GuestEnabled')
        return val === '0'
      } catch {
        return false
      }
    },
    async apply() {
      await elevatedDefaultsWrite(
        '/Library/Preferences/com.apple.loginwindow',
        'GuestEnabled',
        'bool',
        'false'
      )
    }
  },
  {
    id: 'macos-auto-login',
    category: 'kernel',
    label: 'Automatic Login',
    description: 'Disable automatic login to require authentication at startup',
    requiresAdmin: true,
    state: [prefPart('/Library/Preferences/com.apple.loginwindow', 'autoLoginUser', null)],
    async check() {
      try {
        const val = await defaultsRead(
          '/Library/Preferences/com.apple.loginwindow',
          'autoLoginUser'
        )
        // If the key exists and has a value, auto-login is enabled
        return !val || val.length === 0
      } catch {
        // Key doesn't exist = auto-login is disabled = good
        return true
      }
    },
    async apply() {
      await elevatedDefaultsDelete(
        '/Library/Preferences/com.apple.loginwindow',
        'autoLoginUser'
      ).catch(() => {})
    }
  }
]

// ─── Network Hardening ──────────────────────────────────────

const DARWIN_NETWORK_SETTINGS: DarwinPrivacySetting[] = [
  {
    id: 'macos-firewall',
    category: 'network',
    label: 'Application Firewall',
    description: 'Enable the macOS Application Firewall to control incoming connections',
    requiresAdmin: true,
    state: [firewallPart],
    async check() {
      try {
        const out = await socketfilterfwGet('--getglobalstate')
        return out.toLowerCase().includes('enabled')
      } catch {
        return false
      }
    },
    async apply() {
      await socketfilterfwSet('--setglobalstate', 'on')
    }
  },
  {
    id: 'macos-stealth-mode',
    category: 'network',
    label: 'Stealth Mode',
    description: 'Enable stealth mode so your Mac does not respond to probe requests (ICMP ping)',
    requiresAdmin: true,
    state: [stealthPart],
    dependsOn: 'macos-firewall',
    async check() {
      try {
        const out = await socketfilterfwGet('--getstealthmode')
        return out.toLowerCase().includes('enabled')
      } catch {
        return false
      }
    },
    async apply() {
      await socketfilterfwSet('--setstealthmode', 'on')
      await restartAlf()
    }
  },
  {
    id: 'macos-ip-forwarding',
    category: 'network',
    label: 'Disable IP Forwarding',
    description: 'Prevent the system from forwarding packets between network interfaces',
    requiresAdmin: true,
    state: sysctlParts('net.inet.ip.forwarding', '0'),
    async check() {
      try {
        return (await sysctlGet('net.inet.ip.forwarding')) === '0'
      } catch {
        return false
      }
    },
    async apply() {
      await sysctlApply('net.inet.ip.forwarding', '0')
    }
  },
  {
    id: 'macos-block-signed-auto',
    category: 'network',
    label: 'Block Signed App Auto-Allow',
    description: 'Prevent signed applications from automatically bypassing the firewall',
    requiresAdmin: true,
    state: [
      allowSignedPart('--setallowsigned', /built-?in/i),
      allowSignedPart('--setallowsignedapp', /download/i)
    ],
    dependsOn: 'macos-firewall',
    async check() {
      try {
        const out = await socketfilterfwGet('--getallowsigned')
        // Output has two lines (built-in + download). Hardened = neither says "enabled"
        return !out.toLowerCase().includes('enabled')
      } catch {
        return false
      }
    },
    async apply() {
      // Must disable both built-in and downloaded signed app auto-allow
      await socketfilterfwSet('--setallowsignedapp', 'off')
      await socketfilterfwSet('--setallowsigned', 'off')
      await restartAlf()
    }
  }
]

// ─── Access Control ─────────────────────────────────────────

const DARWIN_ACCESS_SETTINGS: DarwinPrivacySetting[] = [
  {
    id: 'macos-remote-login',
    category: 'access',
    label: 'Disable Remote Login (SSH)',
    description:
      'Disable the SSH server entirely. If you need SSH access, leave this off and harden SSH settings instead',
    requiresAdmin: true,
    state: [
      launchdPart(SSHD_LABEL, 22, (enabled) => ({
        cmd: '/bin/sh',
        args: ['-c', enabled ? SSHD_ENABLE_SCRIPT : SSHD_DISABLE_SCRIPT]
      }))
    ],
    async check() {
      return !(await isLaunchdServiceEnabled(SSHD_LABEL, 22))
    },
    async apply() {
      await elevatedExec('/bin/sh', ['-c', SSHD_DISABLE_SCRIPT])
    }
  },
  {
    id: 'macos-ssh-root-login',
    category: 'access',
    label: 'Disable SSH Root Login',
    description: 'Prevent direct root login over SSH — use sudo from a regular account instead',
    requiresAdmin: true,
    state: [sshdPart('PermitRootLogin', 'no')],
    async check() {
      try {
        const content = await readFile('/etc/ssh/sshd_config', 'utf8')
        return /^\s*PermitRootLogin\s+no\s*$/m.test(content)
      } catch {
        return false
      }
    },
    async apply() {
      await applySshdDirective('PermitRootLogin', 'no')
    }
  },
  {
    id: 'macos-ssh-password-auth',
    category: 'access',
    label: 'Disable SSH Password Authentication',
    description:
      'Require key-based SSH authentication only. WARNING: ensure SSH keys are configured before enabling or you may be locked out',
    requiresAdmin: true,
    state: [sshdPart('PasswordAuthentication', 'no')],
    async check() {
      try {
        const content = await readFile('/etc/ssh/sshd_config', 'utf8')
        return /^\s*PasswordAuthentication\s+no\s*$/m.test(content)
      } catch {
        return false
      }
    },
    async apply() {
      await applySshdDirective('PasswordAuthentication', 'no')
    }
  },
  {
    id: 'macos-core-dumps',
    category: 'access',
    label: 'Disable Core Dumps',
    description: 'Prevent core dumps to avoid leaking sensitive memory contents',
    requiresAdmin: true,
    state: sysctlParts('kern.coredump', '0', '1'),
    async check() {
      try {
        return (await sysctlGet('kern.coredump')) === '0'
      } catch {
        return false
      }
    },
    async apply() {
      await sysctlApply('kern.coredump', '0')
    }
  }
]
