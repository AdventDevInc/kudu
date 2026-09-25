import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'

const execFileMock = vi.fn()
vi.mock('child_process', () => ({
  execFile: execFileMock
}))
vi.mock('util', () => ({
  promisify: (fn: any) => fn
}))
// In-memory file system: config files, plists (existence only) and Kudu's own store
const files = new Map<string, string>()
// Plists only root can read (cfprefsd creates new files 0600)
const rootOnly = new Set<string>()
// Permission bits and owner per file (default 0644, root:wheel = 0:0)
const modes = new Map<string, number>()
const owners = new Map<string, string>()
const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    if (!files.has(path)) throw enoent(path)
    return files.get(path)
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    files.set(path, content)
  }),
  rename: vi.fn(async (from: string, to: string) => {
    files.set(to, files.get(from)!)
    files.delete(from)
  }),
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async (path: string) => {
    if (!files.has(path)) throw enoent(path)
    if (rootOnly.has(path)) throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' })
  }),
  constants: { R_OK: 4 },
  stat: vi.fn(async (path: string) => {
    if (!files.has(path)) throw enoent(path)
    const [uid, gid] = (owners.get(path) ?? '0:0').split(':').map(Number)
    return { mode: 0o100000 | (modes.get(path) ?? 0o644), uid, gid }
  }),
  unlink: vi.fn(async (path: string) => {
    files.delete(path)
  })
}))
vi.mock('os', () => ({
  tmpdir: () => '/tmp',
  homedir: () => '/Users/TestUser'
}))
let uuid = 0
vi.mock('crypto', () => ({
  randomUUID: () => `test-uuid-${++uuid}`
}))
const USER_DATA = '/Users/TestUser/Library/Application Support/Kudu'
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => USER_DATA }
}))

const { createDarwinPrivacy } = await import('./privacy')

describe('darwin privacy', () => {
  const privacy = createDarwinPrivacy()

  describe('getSettings', () => {
    const settings = privacy.getSettings()

    it('returns a non-empty array of settings', () => {
      expect(settings.length).toBeGreaterThan(10)
    })

    it('every setting has required fields', () => {
      for (const setting of settings) {
        expect(setting.id).toBeTruthy()
        expect(setting.category).toBeTruthy()
        expect(setting.label).toBeTruthy()
        expect(setting.description).toBeTruthy()
        expect(typeof setting.requiresAdmin).toBe('boolean')
        expect(typeof setting.check).toBe('function')
        expect(typeof setting.apply).toBe('function')
      }
    })

    it('every setting has a unique id', () => {
      const ids = settings.map((s) => s.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('all ids start with macos-', () => {
      for (const setting of settings) {
        expect(setting.id.startsWith('macos-')).toBe(true)
      }
    })

    it('includes telemetry settings', () => {
      const telemetry = settings.filter((s) => s.category === 'telemetry')
      expect(telemetry.length).toBeGreaterThan(0)
      const ids = telemetry.map((s) => s.id)
      expect(ids).toContain('macos-diagnostics')
      expect(ids).toContain('macos-siri-analytics')
      expect(ids).toContain('macos-crash-reporter')
    })

    it('includes ads settings', () => {
      const ads = settings.filter((s) => s.category === 'ads')
      expect(ads.length).toBeGreaterThan(0)
      expect(ads.some((s) => s.id === 'macos-ad-tracking')).toBe(true)
    })

    it('includes search settings', () => {
      const search = settings.filter((s) => s.category === 'search')
      expect(search.length).toBeGreaterThan(0)
      expect(search.some((s) => s.id === 'macos-safari-suggestions')).toBe(true)
      expect(search.some((s) => s.id === 'macos-spotlight-suggestions')).toBe(true)
    })

    it('includes sync settings', () => {
      const sync = settings.filter((s) => s.category === 'sync')
      expect(sync.length).toBeGreaterThan(0)
      expect(sync.some((s) => s.id === 'macos-handoff')).toBe(true)
    })

    it('includes AI settings', () => {
      const ai = settings.filter((s) => s.category === 'ai')
      expect(ai.length).toBeGreaterThan(0)
      expect(ai.some((s) => s.id === 'macos-siri-enabled')).toBe(true)
      expect(ai.some((s) => s.id === 'macos-apple-intelligence')).toBe(true)
    })

    it('includes browser settings', () => {
      const browser = settings.filter((s) => s.category === 'browser')
      expect(browser.length).toBeGreaterThan(0)
      expect(browser.some((s) => s.id === 'macos-safari-dnt')).toBe(true)
      expect(browser.some((s) => s.id === 'macos-chrome-metrics')).toBe(true)
      expect(browser.some((s) => s.id === 'macos-firefox-telemetry')).toBe(true)
    })

    it('includes kernel hardening settings', () => {
      const kernel = settings.filter((s) => s.category === 'kernel')
      expect(kernel.length).toBeGreaterThan(0)
      expect(kernel.some((s) => s.id === 'macos-gatekeeper')).toBe(true)
      expect(kernel.some((s) => s.id === 'macos-guest-account')).toBe(true)
    })

    it('includes network settings', () => {
      const network = settings.filter((s) => s.category === 'network')
      expect(network.length).toBeGreaterThan(0)
      expect(network.some((s) => s.id === 'macos-firewall')).toBe(true)
      expect(network.some((s) => s.id === 'macos-stealth-mode')).toBe(true)
    })

    it('includes access control settings', () => {
      const access = settings.filter((s) => s.category === 'access')
      expect(access.length).toBeGreaterThan(0)
      expect(access.some((s) => s.id === 'macos-remote-login')).toBe(true)
      expect(access.some((s) => s.id === 'macos-ssh-root-login')).toBe(true)
    })

    it('marks admin-requiring settings correctly', () => {
      const diagnostics = settings.find((s) => s.id === 'macos-diagnostics')
      expect(diagnostics!.requiresAdmin).toBe(true)

      const adTracking = settings.find((s) => s.id === 'macos-ad-tracking')
      expect(adTracking!.requiresAdmin).toBe(false)
    })

    it('stealth mode depends on firewall', () => {
      const stealth = settings.find((s) => s.id === 'macos-stealth-mode')
      expect(stealth!.dependsOn).toBe('macos-firewall')
    })

    it('covers all expected categories', () => {
      const categories = new Set(settings.map((s) => s.category))
      expect(categories).toContain('telemetry')
      expect(categories).toContain('ads')
      expect(categories).toContain('search')
      expect(categories).toContain('sync')
      expect(categories).toContain('ai')
      expect(categories).toContain('browser')
      expect(categories).toContain('kernel')
      expect(categories).toContain('network')
      expect(categories).toContain('access')
      expect(categories).toContain('services')
    })
  })
})

// Regression tests for #443: checks must not rely on root-only tools, or a
// successful elevated apply is immediately reported back as "unprotected".
describe('darwin privacy checks run unprivileged', () => {
  const settings = createDarwinPrivacy().getSettings()
  const find = (id: string) => settings.find((s) => s.id === id)!

  function mockExec(handler: (cmd: string, args: string[]) => { stdout: string } | Error) {
    execFileMock.mockReset()
    execFileMock.mockImplementation(async (cmd: string, args: string[]) => {
      const result = handler(cmd, args)
      if (result instanceof Error) throw result
      return result
    })
  }

  const calledCommands = () => execFileMock.mock.calls.map((c) => c[0] as string)

  describe('macos-remote-login', () => {
    it('reads launchd override table instead of systemsetup', async () => {
      mockExec((cmd, args) => {
        if (cmd === '/bin/launchctl' && args[0] === 'print-disabled') {
          return { stdout: 'disabled services = {\n\t"com.openssh.sshd" => disabled\n}\n' }
        }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-remote-login').check()).toBe(true)
      expect(calledCommands()).not.toContain('/usr/sbin/systemsetup')
    })

    it('reports unprotected when sshd is enabled', async () => {
      mockExec((cmd, args) => {
        if (cmd === '/bin/launchctl' && args[0] === 'print-disabled') {
          return { stdout: '"com.openssh.sshd" => enabled' }
        }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-remote-login').check()).toBe(false)
    })

    it('understands the older true/false override format', async () => {
      mockExec((cmd) => {
        if (cmd === '/bin/launchctl') return { stdout: '"com.openssh.sshd" => false' }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-remote-login').check()).toBe(false)
    })

    it('falls back to probing port 22 when launchctl gives no answer', async () => {
      mockExec((cmd, args) => {
        if (cmd === '/bin/launchctl') return { stdout: 'disabled services = {\n}\n' }
        if (cmd === '/usr/bin/nc') {
          expect(args).toContain('22')
          return new Error('connection refused')
        }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-remote-login').check()).toBe(true)
    })

    it('apply disables sshd via launchctl as well as systemsetup', async () => {
      mockExec(() => ({ stdout: '' }))
      await find('macos-remote-login').apply()
      const elevated = execFileMock.mock.calls.find((c) => c[0] === '/usr/bin/osascript')!
      const script = elevated[1].join(' ')
      expect(script).toContain('systemsetup -f -setremotelogin off')
      expect(script).toContain('launchctl disable system/com.openssh.sshd')
      expect(script).toContain('launchctl bootout system/com.openssh.sshd')
    })
  })

  describe('macos-wake-on-network', () => {
    it('reads pmset instead of systemsetup', async () => {
      mockExec((cmd) => {
        if (cmd === '/usr/bin/pmset')
          return { stdout: ' womp                 0\n sleep                1\n' }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-wake-on-network').check()).toBe(true)
      mockExec((cmd) => {
        if (cmd === '/usr/bin/pmset') return { stdout: ' womp                 1\n' }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-wake-on-network').check()).toBe(false)
    })
  })

  describe('managed browser preferences', () => {
    const chromeInstalled = (cmd: string) =>
      cmd === '/usr/bin/mdfind' ? { stdout: '/Applications/Google Chrome.app\n' } : null

    it('reads the plist directly via plutil (bypasses cfprefsd cache)', async () => {
      mockExec((cmd, args) => {
        const found = chromeInstalled(cmd)
        if (found) return found
        if (cmd === '/usr/bin/plutil') {
          expect(args).toEqual([
            '-extract',
            'MetricsReportingEnabled',
            'raw',
            '-o',
            '-',
            '/Library/Managed Preferences/com.google.Chrome.plist'
          ])
          return { stdout: 'false\n' }
        }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-chrome-metrics').check()).toBe(true)
      expect(calledCommands()).not.toContain('/usr/bin/defaults')
    })

    it('falls back to defaults read when plutil fails', async () => {
      mockExec((cmd) => {
        const found = chromeInstalled(cmd)
        if (found) return found
        if (cmd === '/usr/bin/plutil') return new Error('no such file')
        if (cmd === '/usr/bin/defaults') return { stdout: '0\n' }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-chrome-metrics').check()).toBe(true)
    })

    it('reports unprotected when the policy is absent or unreadable', async () => {
      mockExec((cmd) => chromeInstalled(cmd) ?? new Error('permission denied'))
      expect(await find('macos-chrome-metrics').check()).toBe(false)
    })

    it('chmods the managed prefs plist so the user-level check can read it back', async () => {
      mockExec(() => ({ stdout: '' }))
      await find('macos-chrome-metrics').apply()
      const script = execFileMock.mock.calls[0][1].join(' ')
      expect(script).toContain("'write' '/Library/Managed Preferences/com.google.Chrome'")
      expect(script).toContain(
        "'/bin/chmod' '644' '/Library/Managed Preferences/com.google.Chrome.plist'"
      )
    })
  })
})

// ─── Revert: capture the user's state, restore exactly that ────────────
// A small fake Mac: every command — run directly or inside the osascript
// elevation script — is interpreted against this state, so apply and revert
// run end to end.

type Pref = { type: string; value: string }
interface FakeMac {
  defaults: Map<string, Pref>
  sysctl: Map<string, string>
  firewall: { global: number; stealth: boolean; builtin: boolean; downloaded: boolean }
  launchd: Map<string, 'enabled' | 'disabled'>
  gatekeeper: boolean
  /** Simulate macOS ignoring `spctl --master-disable` (Sequoia) */
  gatekeeperLocked: boolean
  womp: Record<string, string>
  failing: Set<string>
}

let mac: FakeMac
const elevatedCalls: string[][] = []
const STORE = join(USER_DATA, 'privacy-prior-state.json')
const storedSettings = () => JSON.parse(files.get(STORE) ?? '{"settings":{}}').settings
const pref = (type: string, value: string): Pref => ({ type, value })
const prefId = (domain: string, key: string, host = false) => `${host ? 'H:' : ''}${domain}\t${key}`
const LOGINWINDOW = '/Library/Preferences/com.apple.loginwindow'
const CHROME_POLICY = '/Library/Managed Preferences/com.google.Chrome'

function failure(stderr: string) {
  return Object.assign(new Error(`Command failed\n${stderr}`), { stderr })
}

function defaultsCommand(input: string[]): string {
  const host = input[0] === '-currentHost'
  const [verb, domain, key, flag, value] = host ? input.slice(1) : input
  const id = prefId(domain, key, host)
  const missing = () => failure(`The domain/default pair of (${domain}, ${key}) does not exist`)
  const names: Record<string, string> = {
    bool: 'boolean',
    int: 'integer',
    float: 'float',
    string: 'string',
    array: 'array'
  }
  const current = mac.defaults.get(id)
  switch (verb) {
    case 'read-type':
      if (!current) throw missing()
      return `Type is ${names[current.type]}\n`
    case 'read':
      if (!current) throw missing()
      return current.value + '\n'
    case 'write': {
      const type = flag.slice(1)
      mac.defaults.set(id, pref(type, type === 'bool' ? (value === 'true' ? '1' : '0') : value))
      // cfprefsd creates new system plists owner-only
      if (domain.startsWith('/') && !files.has(`${domain}.plist`)) {
        files.set(`${domain}.plist`, 'plist')
        modes.set(`${domain}.plist`, 0o600)
      }
      return ''
    }
    case 'delete':
      if (!mac.defaults.delete(id)) throw missing()
      return ''
  }
  throw new Error(`unexpected defaults ${input.join(' ')}`)
}

function plutilCommand(args: string[], root: boolean): string {
  const [, key, format, , , file] = args
  if (!files.has(file)) throw failure('file does not exist')
  if (rootOnly.has(file) && !root) throw failure('Permission denied')
  const current = mac.defaults.get(prefId(file.replace(/\.plist$/, ''), key))
  if (!current)
    throw failure(
      `Could not extract value, error: No value at that key path or invalid key path: ${key}`
    )
  if (format === 'raw')
    return current.type === 'bool' ? (current.value === '1' ? 'true' : 'false') : current.value
  const tag = ({ int: 'integer', float: 'real', string: 'string' } as Record<string, string>)[
    current.type
  ]
  const body =
    current.type === 'bool'
      ? current.value === '1'
        ? '<true/>'
        : '<false/>'
      : `<${tag}>${current.value.replace(/&/g, '&amp;').replace(/'/g, '&apos;')}</${tag}>`
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n${body}\n</plist>\n`
}

function run(cmd: string, args: string[], root = false): string {
  const line = [cmd, ...args].join(' ')
  for (const f of mac.failing) if (line.includes(f)) throw failure(`simulated failure: ${f}`)
  const fw = mac.firewall
  switch (cmd) {
    case '/usr/bin/defaults':
      return defaultsCommand(args)
    case '/usr/bin/plutil':
      return plutilCommand(args, root)
    case '/usr/sbin/sysctl':
      if (args[0] === '-n') return mac.sysctl.get(args[1]) + '\n'
      mac.sysctl.set(args[1].split('=')[0], args[1].split('=')[1])
      return ''
    case '/usr/libexec/ApplicationFirewall/socketfilterfw': {
      const on = args[1] === 'on'
      switch (args[0]) {
        case '--getglobalstate':
          return `Firewall is ${fw.global ? 'enabled' : 'disabled'}. (State = ${fw.global})\n`
        case '--getstealthmode':
          return `Firewall stealth mode is ${fw.stealth ? 'on' : 'off'}\n`
        case '--getallowsigned':
          return (
            `Automatically allow built-in signed software ${fw.builtin ? 'ENABLED' : 'DISABLED'}.\n` +
            `Automatically allow downloaded signed software ${fw.downloaded ? 'ENABLED' : 'DISABLED'}.\n`
          )
        case '--setglobalstate':
          fw.global = on ? 1 : 0
          return ''
        case '--setblockall':
          if (fw.global) fw.global = on ? 2 : 1
          return ''
        case '--setstealthmode':
          fw.stealth = on
          return ''
        case '--setallowsigned':
          fw.builtin = on
          return ''
        case '--setallowsignedapp':
          fw.downloaded = on
          return ''
      }
      break
    }
    case '/bin/launchctl':
      if (args[0] === 'print-disabled')
        return [...mac.launchd].map(([label, state]) => `\t"${label}" => ${state}\n`).join('')
      return ''
    case '/bin/sh': {
      // REMOVE_IF_EMPTY: sh -c <script> sh <file>
      if (args.length === 4) {
        const domain = args[3].replace(/\.plist$/, '')
        if (![...mac.defaults.keys()].some((id) => id.startsWith(`${domain}	`)))
          files.delete(args[3])
        return ''
      }
      // DELETE_IF_PRESENT: sh -c <script> sh <domain> <key>
      if (args.length === 5) {
        try {
          defaultsCommand(['delete', args[3], args[4]])
        } catch (error) {
          if (!/does not exist/.test(String((error as Error).message))) throw error
        }
        return ''
      }
      const label = args[1].match(/launchctl (enable|disable) system\/([\w.]+)/)
      if (label) mac.launchd.set(label[2], label[1] === 'enable' ? 'enabled' : 'disabled')
      return ''
    }
    case '/usr/sbin/systemsetup':
      if (args[0] === '-setremoteappleevents')
        mac.launchd.set('com.apple.AEServer', args[1] === 'on' ? 'enabled' : 'disabled')
      return ''
    case '/usr/sbin/spctl':
      if (args[0] === '--status') return `assessments ${mac.gatekeeper ? 'enabled' : 'disabled'}\n`
      if (!mac.gatekeeperLocked) mac.gatekeeper = args[0] === '--master-enable'
      return ''
    case '/usr/bin/pmset':
      if (args[0] === '-g')
        return Object.entries(mac.womp)
          .map(
            ([source, value]) =>
              `${source}:\n Sleep On Power Button 1\n womp                 ${value}\n`
          )
          .join('')
      mac.womp[args[0] === '-b' ? 'Battery Power' : 'AC Power'] = args[2]
      return ''
    case '/bin/mv':
      // The moved file keeps the temp file's inode: user-owned, umask mode
      files.set(args[2], files.get(args[1])!)
      files.delete(args[1])
      owners.set(args[2], '501:20')
      modes.set(args[2], 0o644)
      return ''
    case '/bin/rm':
      files.delete(args[1])
      return ''
    case '/usr/sbin/chown':
      owners.set(args[1], args[0].replace('root:wheel', '0:0'))
      return ''
    case '/bin/chmod':
      modes.set(args[1], parseInt(args[0], 8))
      return ''
    case '/bin/mkdir':
      return ''
    case '/usr/bin/nc':
      throw failure('connection refused')
    case '/usr/bin/mdfind':
      return '/Applications/Google Chrome.app\n'
  }
  throw new Error(`unexpected command ${line}`)
}

// Undo shellEscape: 'it'\''s' → it's
function unquote(word: string): string {
  return word
    .split("'\\''")
    .map((piece) => piece.replace(/^'|'$/g, ''))
    .join("'")
}

function runChain(chain: string): string {
  // Tokenise outside quotes: shell words, `&&`, and the `{ … || true; }` wrapper
  const commands = [{ argv: [] as string[], optional: false }]
  for (const token of chain.match(/(?:'[^']*'|\\')+|&&|\|\||[{}]|true;/g) ?? []) {
    const current = commands[commands.length - 1]
    if (token === '&&') commands.push({ argv: [], optional: false })
    else if (token === '{') current.optional = true
    else if (!['||', 'true;', '}'].includes(token)) current.argv.push(unquote(token))
  }
  let out = ''
  for (const { argv, optional } of commands) {
    const [cmd, ...args] = argv
    elevatedCalls.push(argv)
    try {
      out = run(cmd, args, true)
    } catch (error) {
      if (!optional) throw error
    }
  }
  return out
}

function osascript(appleScript: string): string {
  const script: string = JSON.parse(appleScript.match(/^do shell script (".*") with prompt /s)![1])
  if (!script.includes('kudu-group:')) return runChain(script)
  return [...script.matchAll(/\((.*?)\) 1>&2; echo kudu-group:(\d+):\$\?/g)]
    .map(([, chain, i]) => {
      try {
        runChain(chain)
        return `kudu-group:${i}:0`
      } catch {
        return `kudu-group:${i}:1`
      }
    })
    .join('\r')
}

function freshMac(): FakeMac {
  return {
    defaults: new Map(),
    sysctl: new Map([
      ['kern.coredump', '1'],
      ['net.inet.ip.forwarding', '0']
    ]),
    firewall: { global: 0, stealth: false, builtin: true, downloaded: true },
    launchd: new Map(),
    gatekeeper: true,
    gatekeeperLocked: false,
    womp: { 'AC Power': '1' },
    failing: new Set()
  }
}

const osascriptCalls = () => execFileMock.mock.calls.filter((c) => c[0] === '/usr/bin/osascript')

describe('darwin privacy revert', () => {
  let privacy = createDarwinPrivacy()
  const find = (id: string) => privacy.getSettings().find((s) => s.id === id)!

  beforeEach(() => {
    files.clear()
    rootOnly.clear()
    modes.clear()
    owners.clear()
    elevatedCalls.length = 0
    mac = freshMac()
    privacy = createDarwinPrivacy()
    execFileMock.mockReset()
    execFileMock.mockImplementation(async (cmd: string, args: string[]) => ({
      stdout: cmd === '/usr/bin/osascript' ? osascript(args[1]) : run(cmd, args),
      stderr: ''
    }))
  })

  it('every setting can be reverted', () => {
    for (const setting of privacy.getSettings()) {
      expect(typeof setting.revert).toBe('function')
      expect(typeof setting.canRevert).toBe('function')
    }
  })

  describe('preference keys', () => {
    it('captures and persists the prior value before apply writes anything', async () => {
      mac.defaults.set(prefId('com.apple.Safari', 'UniversalSearchEnabled'), pref('bool', '1'))
      let storedAtWrite: unknown
      execFileMock.mockImplementation(async (cmd: string, args: string[]) => {
        if (args.includes('write')) storedAtWrite = storedSettings()
        return { stdout: run(cmd, args), stderr: '' }
      })

      await find('macos-safari-suggestions').apply()

      const verbs = execFileMock.mock.calls.map((c) => c[1][0])
      expect(verbs.indexOf('read-type')).toBeLessThan(verbs.indexOf('write'))
      expect(storedAtWrite).toEqual({
        'macos-safari-suggestions': {
          'defaults:com.apple.Safari:UniversalSearchEnabled': { type: 'bool', value: '1' }
        }
      })
      expect(mac.defaults.get(prefId('com.apple.Safari', 'UniversalSearchEnabled'))).toEqual(
        pref('bool', '0')
      )
    })

    it('restores the exact prior value and type', async () => {
      const siri = prefId('com.apple.assistant.support', 'Siri Data Sharing Opt-In Status')
      const crash = prefId('com.apple.CrashReporter', 'DialogType')
      const handoff = prefId(
        'com.apple.coreservices.useractivityd',
        'ActivityReceivingAllowed',
        true
      )
      mac.defaults.set(siri, pref('int', '1'))
      mac.defaults.set(crash, pref('string', 'developer'))
      mac.defaults.set(handoff, pref('bool', '1'))
      for (const id of ['macos-siri-analytics', 'macos-crash-reporter', 'macos-handoff'])
        await find(id).apply()
      expect(mac.defaults.get(siri)).toEqual(pref('int', '2'))

      const result = await privacy.revertSettings!([
        'macos-siri-analytics',
        'macos-crash-reporter',
        'macos-handoff'
      ])

      expect(result).toEqual({ succeeded: 3, failed: 0, errors: [] })
      expect(mac.defaults.get(siri)).toEqual(pref('int', '1'))
      expect(mac.defaults.get(crash)).toEqual(pref('string', 'developer'))
      expect(mac.defaults.get(handoff)).toEqual(pref('bool', '1'))
      const writes = execFileMock.mock.calls.map((c) => c[1]).filter((a) => a.includes('write'))
      expect(writes).toContainEqual([
        'write',
        'com.apple.assistant.support',
        'Siri Data Sharing Opt-In Status',
        '-int',
        '1'
      ])
      expect(writes).toContainEqual([
        '-currentHost',
        'write',
        'com.apple.coreservices.useractivityd',
        'ActivityReceivingAllowed',
        '-bool',
        'true'
      ])
      // User-level settings never ask for a password
      expect(osascriptCalls()).toHaveLength(0)
      expect(storedSettings()).toEqual({})
    })

    it('deletes a key that did not exist before apply', async () => {
      await find('macos-safari-dnt').apply()
      expect(mac.defaults.has(prefId('com.apple.Safari', 'SendDoNotTrackHTTPHeader'))).toBe(true)

      await find('macos-safari-dnt').revert!()

      expect(mac.defaults.has(prefId('com.apple.Safari', 'SendDoNotTrackHTTPHeader'))).toBe(false)
      expect(execFileMock.mock.calls.map((c) => c[1])).toContainEqual([
        'delete',
        'com.apple.Safari',
        'SendDoNotTrackHTTPHeader'
      ])
    })

    it('reads system plists directly and restores them as root', async () => {
      files.set(`${LOGINWINDOW}.plist`, 'plist')
      mac.defaults.set(prefId(LOGINWINDOW, 'GuestEnabled'), pref('bool', '1'))
      mac.defaults.set(prefId(LOGINWINDOW, 'autoLoginUser'), pref('string', "o'brien & co"))
      await find('macos-guest-account').apply()
      await find('macos-auto-login').apply()
      expect(mac.defaults.has(prefId(LOGINWINDOW, 'autoLoginUser'))).toBe(false)
      expect(execFileMock.mock.calls.map((c) => c[0])).toContain('/usr/bin/plutil')

      const result = await privacy.revertSettings!(['macos-guest-account', 'macos-auto-login'])

      expect(result.succeeded).toBe(2)
      expect(mac.defaults.get(prefId(LOGINWINDOW, 'GuestEnabled'))).toEqual(pref('bool', '1'))
      expect(mac.defaults.get(prefId(LOGINWINDOW, 'autoLoginUser'))).toEqual(
        pref('string', "o'brien & co")
      )
      expect(elevatedCalls).toContainEqual([
        '/usr/bin/defaults',
        'write',
        LOGINWINDOW,
        'autoLoginUser',
        '-string',
        "o'brien & co"
      ])
    })

    it('removes a managed policy plist Kudu created', async () => {
      await find('macos-chrome-metrics').apply()
      expect(mac.defaults.get(prefId(CHROME_POLICY, 'MetricsReportingEnabled'))).toEqual(
        pref('bool', '0')
      )
      expect(modes.get(`${CHROME_POLICY}.plist`)).toBe(0o644)

      await find('macos-chrome-metrics').revert!()

      expect(mac.defaults.has(prefId(CHROME_POLICY, 'MetricsReportingEnabled'))).toBe(false)
      expect(files.has(`${CHROME_POLICY}.plist`)).toBe(false)
      expect(storedSettings()).toEqual({})
    })

    it("restores an existing policy plist's owner-only mode and keeps its other policies", async () => {
      files.set(`${CHROME_POLICY}.plist`, 'plist')
      modes.set(`${CHROME_POLICY}.plist`, 0o600)
      mac.defaults.set(
        prefId(CHROME_POLICY, 'HomepageLocation'),
        pref('string', 'https://intranet')
      )
      await find('macos-chrome-metrics').apply()
      await find('macos-chrome-safe-browsing').apply()
      expect(modes.get(`${CHROME_POLICY}.plist`)).toBe(0o644)
      execFileMock.mockClear()

      const result = await privacy.revertSettings!([
        'macos-chrome-metrics',
        'macos-chrome-safe-browsing'
      ])

      expect(result).toEqual({ succeeded: 2, failed: 0, errors: [] })
      expect(osascriptCalls()).toHaveLength(1)
      expect(modes.get(`${CHROME_POLICY}.plist`)).toBe(0o600)
      expect(files.has(`${CHROME_POLICY}.plist`)).toBe(true)
      expect(mac.defaults.get(prefId(CHROME_POLICY, 'HomepageLocation'))).toEqual(
        pref('string', 'https://intranet')
      )
      expect(storedSettings()).toEqual({})
    })

    it('keeps a plist Kudu created while it still holds other policies', async () => {
      await find('macos-chrome-metrics').apply()
      mac.defaults.set(prefId(CHROME_POLICY, 'HomepageLocation'), pref('string', 'https://mdm'))

      await find('macos-chrome-metrics').revert!()

      expect(files.has(`${CHROME_POLICY}.plist`)).toBe(true)
      expect(mac.defaults.get(prefId(CHROME_POLICY, 'HomepageLocation'))).toEqual(
        pref('string', 'https://mdm')
      )
    })

    it('refuses to apply when the current value could not be restored exactly', async () => {
      mac.defaults.set(prefId('com.apple.AdLib', 'allowApplePersonalizedAdvertising'), {
        type: 'array',
        value: '(\n    1\n)'
      })

      await expect(find('macos-ad-tracking').apply()).rejects.toThrow(/nothing was changed/)
      expect(execFileMock.mock.calls.some((c) => c[1].includes('write'))).toBe(false)
    })

    it('does not mistake an unreadable preference for an absent one', async () => {
      execFileMock.mockImplementation(async () => {
        throw failure('Could not access preferences: operation not permitted')
      })
      await expect(find('macos-safari-suggestions').apply()).rejects.toThrow(/nothing was changed/)
      expect(storedSettings()).toEqual({})
    })
  })

  describe('config files', () => {
    it('restores the exact sysctl.conf line and live value, leaving other lines alone', async () => {
      const original = '# my tuning\nkern.coredump = 1\nkern.maxfiles=65536\n'
      files.set('/etc/sysctl.conf', original)

      await find('macos-core-dumps').apply()
      expect(mac.sysctl.get('kern.coredump')).toBe('0')
      expect(files.get('/etc/sysctl.conf')).toBe(
        '# my tuning\nkern.coredump=0\nkern.maxfiles=65536\n'
      )

      await find('macos-core-dumps').revert!()

      expect(mac.sysctl.get('kern.coredump')).toBe('1')
      expect(files.get('/etc/sysctl.conf')).toBe(original)
      // Owner and mode survive the temp-file-and-mv write
      expect(owners.get('/etc/sysctl.conf')).toBe('0:0')
      expect(modes.get('/etc/sysctl.conf')).toBe(0o644)
    })

    it("keeps a config file's own owner and restrictive mode through apply and revert", async () => {
      const SSHD_CONFIG = '/etc/ssh/sshd_config'
      files.set(SSHD_CONFIG, 'PermitRootLogin yes\n')
      modes.set(SSHD_CONFIG, 0o600)
      owners.set(SSHD_CONFIG, '0:0')

      await find('macos-ssh-root-login').apply()
      expect([owners.get(SSHD_CONFIG), modes.get(SSHD_CONFIG)]).toEqual(['0:0', 0o600])

      await find('macos-ssh-root-login').revert!()
      expect(files.get(SSHD_CONFIG)).toBe('PermitRootLogin yes\n')
      expect([owners.get(SSHD_CONFIG), modes.get(SSHD_CONFIG)]).toEqual(['0:0', 0o600])
      expect(elevatedCalls).toContainEqual(['/bin/chmod', '600', SSHD_CONFIG])
    })

    it('gives a config file Kudu creates the stock root:wheel 0644', async () => {
      mac.sysctl.set('net.inet.ip.forwarding', '1')
      await find('macos-ip-forwarding').apply()
      expect(elevatedCalls).toContainEqual(['/usr/sbin/chown', 'root:wheel', '/etc/sysctl.conf'])
      expect([owners.get('/etc/sysctl.conf'), modes.get('/etc/sysctl.conf')]).toEqual([
        '0:0',
        0o644
      ])
    })

    it('ends with the same owner and mode when Kudu itself runs as root', async () => {
      const getuid = Object.getOwnPropertyDescriptor(process, 'getuid')
      Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true })
      try {
        files.set('/etc/sysctl.conf', 'kern.coredump=1\n')
        modes.set('/etc/sysctl.conf', 0o600)
        await find('macos-core-dumps').apply()
        expect([owners.get('/etc/sysctl.conf'), modes.get('/etc/sysctl.conf')]).toEqual([
          '0:0',
          0o600
        ])
        await find('macos-core-dumps').revert!()
        expect(files.get('/etc/sysctl.conf')).toBe('kern.coredump=1\n')
        expect(modes.get('/etc/sysctl.conf')).toBe(0o600)
        expect(osascriptCalls()).toHaveLength(0)
      } finally {
        if (getuid) Object.defineProperty(process, 'getuid', getuid)
        else delete (process as { getuid?: unknown }).getuid
      }
    })

    it('removes sysctl.conf again when Kudu created it', async () => {
      mac.sysctl.set('net.inet.ip.forwarding', '1')
      await find('macos-ip-forwarding').apply()
      expect(files.get('/etc/sysctl.conf')).toContain('net.inet.ip.forwarding=0')

      await find('macos-ip-forwarding').revert!()

      expect(files.has('/etc/sysctl.conf')).toBe(false)
      expect(mac.sysctl.get('net.inet.ip.forwarding')).toBe('1')
    })

    it('keeps the original capture when retrying a half-finished apply', async () => {
      files.set('/etc/sysctl.conf', 'kern.coredump=1\n')
      mac.failing.add('/bin/mv')
      await expect(find('macos-core-dumps').apply()).rejects.toThrow()
      expect(mac.sysctl.get('kern.coredump')).toBe('0') // live value already changed

      mac.failing.clear()
      await find('macos-core-dumps').apply()
      expect(storedSettings()['macos-core-dumps']['sysctl:kern.coredump']).toBe('1')

      await find('macos-core-dumps').revert!()
      expect(mac.sysctl.get('kern.coredump')).toBe('1')
      expect(files.get('/etc/sysctl.conf')).toBe('kern.coredump=1\n')
    })

    const SSHD = '/etc/ssh/sshd_config'
    const sshdOriginal =
      '# sshd config\n#PermitRootLogin prohibit-password\nPermitRootLogin yes\nUsePAM yes\n'

    it('puts sshd_config lines back exactly as they were', async () => {
      files.set(SSHD, sshdOriginal)
      await find('macos-ssh-root-login').apply()
      expect(files.get(SSHD)).toBe(
        '# sshd config\n#PermitRootLogin prohibit-password\n# PermitRootLogin yes\nUsePAM yes\nPermitRootLogin no\n'
      )

      await find('macos-ssh-root-login').revert!()

      expect(files.get(SSHD)).toBe(sshdOriginal)
      expect(elevatedCalls).toContainEqual([
        '/bin/launchctl',
        'kickstart',
        '-k',
        'system/com.openssh.sshd'
      ])
    })

    it('refuses to overwrite sshd_config lines edited after apply', async () => {
      files.set(SSHD, sshdOriginal)
      await find('macos-ssh-root-login').apply()
      const edited = files
        .get(SSHD)!
        .replace('PermitRootLogin no', 'PermitRootLogin forced-commands-only')
      files.set(SSHD, edited)
      execFileMock.mockClear()

      await expect(find('macos-ssh-root-login').revert!()).rejects.toThrow(/edited after Kudu/)

      expect(files.get(SSHD)).toBe(edited)
      expect(osascriptCalls()).toHaveLength(0)
      expect(storedSettings()['macos-ssh-root-login']).toBeDefined()
    })
  })

  describe('services and firewall', () => {
    it('restores launchd services, firewall flags and wake-on-network', async () => {
      mac.launchd.set('com.openssh.sshd', 'enabled')
      mac.launchd.set('com.apple.AEServer', 'enabled')
      mac.firewall.global = 1
      mac.womp = { 'Battery Power': '0', 'AC Power': '1' }
      const ids = [
        'macos-remote-login',
        'macos-remote-apple-events',
        'macos-stealth-mode',
        'macos-block-signed-auto',
        'macos-wake-on-network'
      ]
      for (const id of ids) await find(id).apply()
      mac.womp = { 'Battery Power': '0', 'AC Power': '0' } // what systemsetup leaves behind
      expect(mac.launchd.get('com.openssh.sshd')).toBe('disabled')
      expect(mac.firewall).toMatchObject({ stealth: true, builtin: false, downloaded: false })

      const result = await privacy.revertSettings!(ids)

      expect(result).toEqual({ succeeded: 5, failed: 0, errors: [] })
      expect(osascriptCalls().length).toBeGreaterThan(0)
      expect(mac.launchd.get('com.openssh.sshd')).toBe('enabled')
      expect(mac.launchd.get('com.apple.AEServer')).toBe('enabled')
      expect(mac.firewall).toEqual({ global: 1, stealth: false, builtin: true, downloaded: true })
      expect(mac.womp).toEqual({ 'Battery Power': '0', 'AC Power': '1' })
    })

    it('reports a revert macOS silently ignored and keeps the record', async () => {
      mac.gatekeeper = false
      await find('macos-gatekeeper').apply()
      mac.gatekeeperLocked = true

      const result = await privacy.revertSettings!(['macos-gatekeeper'])

      expect(result.failed).toBe(1)
      expect(result.errors[0].reason).toMatch(/didn't report the previous state/)
      expect(storedSettings()['macos-gatekeeper']).toEqual({ 'spctl:assessments': false })
    })
  })

  describe('without a captured state', () => {
    it('falls back to the documented default where it is certain', async () => {
      mac.firewall = { global: 1, stealth: true, builtin: false, downloaded: false }
      mac.sysctl.set('kern.coredump', '0')
      files.set('/etc/sysctl.conf', '# mine\nkern.coredump=0\n')
      files.set(`${CHROME_POLICY}.plist`, 'plist')
      mac.defaults.set(prefId(CHROME_POLICY, 'MetricsReportingEnabled'), pref('bool', '0'))
      const ids = [
        'macos-firewall',
        'macos-stealth-mode',
        'macos-block-signed-auto',
        'macos-core-dumps',
        'macos-chrome-metrics'
      ]
      for (const id of ids) expect(await find(id).canRevert!()).toBe(true)

      const result = await privacy.revertSettings!(ids)

      expect(result).toEqual({ succeeded: 5, failed: 0, errors: [] })
      expect(osascriptCalls()).toHaveLength(1)
      expect(mac.firewall).toEqual({ global: 0, stealth: false, builtin: true, downloaded: true })
      expect(mac.sysctl.get('kern.coredump')).toBe('1')
      expect(files.get('/etc/sysctl.conf')).toBe('# mine\n')
      expect(mac.defaults.has(prefId(CHROME_POLICY, 'MetricsReportingEnabled'))).toBe(false)
    })

    it('stays non-reversible when the default is not certain', async () => {
      mac.defaults.set(
        prefId('com.apple.assistant.support', 'Assistant Enabled'),
        pref('bool', '0')
      )
      files.set('/etc/ssh/sshd_config', 'PermitRootLogin no\n')
      for (const id of ['macos-siri-enabled', 'macos-gatekeeper', 'macos-ssh-root-login'])
        expect(await find(id).canRevert!()).toBe(false)

      const result = await privacy.revertSettings!(['macos-siri-enabled', 'macos-gatekeeper'])

      expect(result.failed).toBe(2)
      expect(result.errors[0].reason).toMatch(/no record of this setting's previous state/)
      expect(execFileMock).not.toHaveBeenCalled()
      expect(mac.defaults.get(prefId('com.apple.assistant.support', 'Assistant Enabled'))).toEqual(
        pref('bool', '0')
      )
    })

    it('treats a setting that was already applied as uncaptured', async () => {
      // Firewall already on: apply changes nothing, so there's nothing of the
      // user's to restore and the documented default is used instead
      mac.firewall.global = 1
      await find('macos-firewall').apply()
      expect(storedSettings()).toEqual({})
    })
  })

  describe('batch elevation', () => {
    const adminIds = [
      'macos-stealth-mode',
      'macos-guest-account',
      'macos-core-dumps',
      'macos-ip-forwarding'
    ]

    async function applyAdminSettings() {
      mac.firewall.global = 1
      files.set(`${LOGINWINDOW}.plist`, 'plist')
      mac.defaults.set(prefId(LOGINWINDOW, 'GuestEnabled'), pref('bool', '1'))
      files.set('/etc/sysctl.conf', 'kern.coredump=1\n')
      mac.sysctl.set('net.inet.ip.forwarding', '1')
      for (const id of adminIds) await find(id).apply()
      execFileMock.mockClear()
      elevatedCalls.length = 0
    }

    it('reverts several admin settings behind a single password prompt', async () => {
      await applyAdminSettings()

      const result = await privacy.revertSettings!(adminIds)

      expect(result).toEqual({ succeeded: 4, failed: 0, errors: [] })
      expect(osascriptCalls()).toHaveLength(1)
      expect(mac.firewall.stealth).toBe(false)
      expect(mac.defaults.get(prefId(LOGINWINDOW, 'GuestEnabled'))).toEqual(pref('bool', '1'))
      expect(mac.sysctl.get('kern.coredump')).toBe('1')
      expect(mac.sysctl.get('net.inet.ip.forwarding')).toBe('1')
      // Both sysctl edits land in the one file
      expect(files.get('/etc/sysctl.conf')).toBe('kern.coredump=1\n')
      expect(storedSettings()).toEqual({})
      expect([...files.keys()].filter((f) => f.includes('kudu-test-uuid'))).toEqual([])
    })

    it('reports each setting separately when one of them fails', async () => {
      await applyAdminSettings()
      mac.failing.add('--setstealthmode')

      const result = await privacy.revertSettings!(['macos-stealth-mode', 'macos-guest-account'])

      expect(osascriptCalls()).toHaveLength(1)
      expect(result.succeeded).toBe(1)
      expect(result.errors.map((e) => e.id)).toEqual(['macos-stealth-mode'])
      expect(Object.keys(storedSettings())).toContain('macos-stealth-mode')
      expect(Object.keys(storedSettings())).not.toContain('macos-guest-account')
    })

    it('fails every admin setting, and forgets nothing, when the prompt is cancelled', async () => {
      await applyAdminSettings()
      execFileMock.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === '/usr/bin/osascript') throw new Error('User canceled. (-128)')
        return { stdout: run(cmd, args), stderr: '' }
      })

      const result = await privacy.revertSettings!(['macos-stealth-mode', 'macos-guest-account'])

      expect(result.failed).toBe(2)
      expect(mac.firewall.stealth).toBe(true)
      expect(Object.keys(storedSettings())).toEqual(
        expect.arrayContaining(['macos-stealth-mode', 'macos-guest-account'])
      )
    })
  })

  describe('root-only system plists', () => {
    const SAFE_BROWSING = 'SafeBrowsingExtendedReportingEnabled'
    const FIREFOX_POLICY = '/Library/Managed Preferences/org.mozilla.firefox'

    async function applyWithRootOnlyPlists() {
      files.set(`${CHROME_POLICY}.plist`, 'plist')
      files.set(`${LOGINWINDOW}.plist`, 'plist')
      mac.defaults.set(prefId(CHROME_POLICY, SAFE_BROWSING), pref('bool', '1'))
      mac.defaults.set(prefId(LOGINWINDOW, 'GuestEnabled'), pref('bool', '1'))
      rootOnly.add(`${CHROME_POLICY}.plist`).add(`${LOGINWINDOW}.plist`)
      modes.set(`${CHROME_POLICY}.plist`, 0o600)
      for (const id of [
        'macos-chrome-metrics',
        'macos-chrome-safe-browsing',
        'macos-firefox-telemetry',
        'macos-guest-account'
      ])
        await find(id).apply()
      // Capture read the root-only plists as root rather than guessing "unset"
      expect(storedSettings()['macos-chrome-safe-browsing']).toEqual({
        [`defaults:${CHROME_POLICY}:${SAFE_BROWSING}`]: { type: 'bool', value: '1' },
        // The user's original mode, carried over from the metrics capture
        [`plist-mode:${CHROME_POLICY}.plist`]: { mode: '600' }
      })
      rootOnly.add(`${FIREFOX_POLICY}.plist`)
      execFileMock.mockClear()
      elevatedCalls.length = 0
    }

    it('reverts several of them behind one password prompt', async () => {
      await applyWithRootOnlyPlists()
      // Already gone: the unconditional delete must tolerate it
      mac.defaults.delete(prefId(FIREFOX_POLICY, 'DisableTelemetry'))

      const result = await privacy.revertSettings!([
        'macos-chrome-metrics',
        'macos-chrome-safe-browsing',
        'macos-firefox-telemetry',
        'macos-guest-account'
      ])

      expect(result).toEqual({ succeeded: 4, failed: 0, errors: [] })
      expect(execFileMock.mock.calls.map((c) => c[0])).toEqual(['/usr/bin/osascript'])
      expect(mac.defaults.has(prefId(CHROME_POLICY, 'MetricsReportingEnabled'))).toBe(false)
      expect(mac.defaults.get(prefId(CHROME_POLICY, SAFE_BROWSING))).toEqual(pref('bool', '1'))
      expect(mac.defaults.get(prefId(LOGINWINDOW, 'GuestEnabled'))).toEqual(pref('bool', '1'))
      expect(modes.get(`${CHROME_POLICY}.plist`)).toBe(0o600)
      expect(storedSettings()).toEqual({})
    })

    it('keeps the record when the root command fails', async () => {
      await applyWithRootOnlyPlists()
      mac.failing.add(SAFE_BROWSING)

      const result = await privacy.revertSettings!([
        'macos-chrome-safe-browsing',
        'macos-guest-account'
      ])

      expect(osascriptCalls()).toHaveLength(1)
      expect(result.errors.map((e) => e.id)).toEqual(['macos-chrome-safe-browsing'])
      expect(storedSettings()['macos-chrome-safe-browsing']).toBeDefined()
    })

    it('leaves the plist readable while another Kudu policy in it is still applied', async () => {
      await applyWithRootOnlyPlists()
      modes.set(`${CHROME_POLICY}.plist`, 0o644) // as managedPrefWrite left it
      rootOnly.clear()

      const result = await privacy.revertSettings!(['macos-chrome-safe-browsing'])

      expect(result).toEqual({ succeeded: 1, failed: 0, errors: [] })
      expect(modes.get(`${CHROME_POLICY}.plist`)).toBe(0o644)
      expect(await find('macos-chrome-metrics').check()).toBe(true)

      await privacy.revertSettings!(['macos-chrome-metrics'])
      expect(modes.get(`${CHROME_POLICY}.plist`)).toBe(0o600)
      expect(storedSettings()).not.toHaveProperty('macos-chrome-metrics')
    })
  })

  it('keeps the captured state across an app restart', async () => {
    mac.defaults.set(prefId('com.apple.Safari', 'CloudTabsEnabled'), pref('int', '1'))
    await find('macos-safari-cloud-tabs').apply()
    expect(files.has(STORE)).toBe(true)

    vi.resetModules()
    const restarted = (await import('./privacy')).createDarwinPrivacy()
    const setting = restarted.getSettings().find((s) => s.id === 'macos-safari-cloud-tabs')!
    expect(await setting.canRevert!()).toBe(true)
    await setting.revert!()

    expect(mac.defaults.get(prefId('com.apple.Safari', 'CloudTabsEnabled'))).toEqual(
      pref('int', '1')
    )
    expect(storedSettings()).toEqual({})
  })
})
