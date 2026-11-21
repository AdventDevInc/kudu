import { app } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { link, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  DEFAULT_APP_POLICY,
  validateAppPolicy,
  type WeekendAppLaunch
} from '../../shared/app-launch'
import { WEEKEND_APP_RUNNER } from './weekend-app-runner'

const exec = promisify(execFile)
const domain = () => `gui/${process.getuid!()}`
const root = () => join(app.getPath('userData'), 'weekend-app-launches')
const label = (id: string) => `com.kudu.weekend-app.${id}`
const agentPath = (id: string) => join(homedir(), 'Library', 'LaunchAgents', `${label(id)}.plist`)

function requireMac(): void {
  if (process.platform !== 'darwin') throw new Error('This feature requires macOS.')
}

function validateId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid schedule ID.')
}

async function loaded(id: string): Promise<boolean> {
  try {
    await exec('/bin/launchctl', ['print', `${domain()}/${label(id)}`], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

// Serialize edits to avoid create/remove races. launchd serializes invocations of each agent.
let editing: Promise<unknown> = Promise.resolve()
function edit<T>(action: () => Promise<T>): Promise<T> {
  const result = editing.then(action, action)
  editing = result.catch(() => {})
  return result
}

export async function listWeekendAppLaunches(): Promise<WeekendAppLaunch[]> {
  requireMac()
  await editing
  let entries: string[]
  try {
    entries = await readdir(root())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const result: WeekendAppLaunch[] = []
  for (const id of entries.filter((entry) => /^[a-f0-9]{32}$/.test(entry))) {
    const config = JSON.parse(await readFile(join(root(), id, 'config.json'), 'utf8'))
    let state = { lastOpened: null, lastError: null }
    try {
      state = JSON.parse(await readFile(join(root(), id, 'state.json'), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    result.push({
      id,
      name: config.name,
      appPath: config.appPath,
      loaded: await loaded(id),
      ...state,
      policy: config.policy ? validateAppPolicy(config.policy) : DEFAULT_APP_POLICY
    })
  }
  return result
}

export function addWeekendAppLaunch(
  appPath: string,
  input: unknown = DEFAULT_APP_POLICY
): Promise<void> {
  return edit(async () => {
    requireMac()
    const policy = validateAppPolicy(input)
    const path = await realpath(appPath)
    if (!path.endsWith('.app') || !(await stat(path)).isDirectory()) {
      throw new Error('Choose a macOS application bundle.')
    }
    await stat(join(path, 'Contents', 'Info.plist'))
    const id = createHash('sha256').update(path).digest('hex').slice(0, 32)
    const directory = join(root(), id)
    await mkdir(root(), { recursive: true, mode: 0o700 })
    // An exclusive directory prevents duplicate schedules for the same application.
    await mkdir(directory, { mode: 0o700 })
    const temporary = join(directory, 'agent.plist')
    let installed = false
    try {
      await writeFile(
        join(directory, 'config.json'),
        JSON.stringify({
          name: basename(path, '.app'),
          appPath: path,
          policy
        }),
        { mode: 0o600 }
      )
      const script = join(directory, 'runner.js')
      await writeFile(script, WEEKEND_APP_RUNNER, { mode: 0o600 })
      await writeFile(
        temporary,
        JSON.stringify({
          Label: label(id),
          ProgramArguments: ['/usr/bin/osascript', '-l', 'JavaScript', script, directory],
          RunAtLoad: true,
          StartInterval: 300,
          LimitLoadToSessionType: 'Aqua'
        }),
        { mode: 0o600 }
      )
      await exec('/usr/bin/plutil', ['-convert', 'xml1', temporary], { timeout: 5000 })
      await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true, mode: 0o700 })
      // Exclusive copy through a temporary file avoids overwriting an existing agent.
      const destination = agentPath(id)
      const staged = destination + '.' + randomUUID()
      try {
        await writeFile(staged, await readFile(temporary), { mode: 0o600, flag: 'wx' })
        // link provides exclusive creation, unlike rename's replace behavior.
        await link(staged, destination)
        installed = true
      } finally {
        await rm(staged, { force: true })
      }
      await exec('/bin/launchctl', ['bootstrap', domain(), destination], { timeout: 10_000 })
    } catch (error) {
      if (installed) {
        // Bootstrap may have registered the agent before returning an error.
        if (await loaded(id)) {
          await exec('/bin/launchctl', ['bootout', `${domain()}/${label(id)}`], { timeout: 10_000 })
        }
        await rm(agentPath(id), { force: true })
      }
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  })
}

export function removeWeekendAppLaunch(id: unknown): Promise<void> {
  return edit(async () => {
    requireMac()
    validateId(id)
    // Only a schedule with our stored config may be removed.
    await readFile(join(root(), id, 'config.json'), 'utf8')
    if (await loaded(id)) {
      await exec('/bin/launchctl', ['bootout', `${domain()}/${label(id)}`], { timeout: 10_000 })
    }
    await rm(agentPath(id), { force: true })
    await rm(join(root(), id), { recursive: true, force: true })
  })
}

export function updateWeekendAppLaunch(id: unknown, input: unknown): Promise<void> {
  return edit(async () => {
    requireMac()
    validateId(id)
    const policy = validateAppPolicy(input)
    const directory = join(root(), id)
    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))
    // Each file is replaced atomically. The new runner also understands legacy configs.
    await atomicUpdate(join(directory, 'runner.js'), WEEKEND_APP_RUNNER)
    await atomicUpdate(join(directory, 'config.json'), JSON.stringify({ ...config, policy }))
  })
}

async function atomicUpdate(path: string, contents: string): Promise<void> {
  const temporary = path + '.' + randomUUID()
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
