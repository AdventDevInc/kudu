import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const mocks = vi.hoisted(() => ({
  root: '',
  home: '',
  loaded: false,
  failBootstrap: false
}))
vi.mock('electron', () => ({ app: { getPath: () => mocks.root } }))
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => mocks.home
}))
vi.mock('child_process', () => ({
  execFile: vi.fn((file, args, options, callback) => {
    let error: Error | null = null
    if (file === '/bin/launchctl') {
      if (args[0] === 'print' && !mocks.loaded) error = new Error('not loaded')
      if (args[0] === 'bootstrap') {
        if (mocks.failBootstrap) error = new Error('bootstrap failed')
        else mocks.loaded = true
      }
      if (args[0] === 'bootout') mocks.loaded = false
    }
    callback(error, '', '')
  })
}))

import {
  addWeekendAppLaunch,
  listWeekendAppLaunches,
  removeWeekendAppLaunch,
  updateWeekendAppLaunch
} from './weekend-app-launches'

describe.skipIf(process.platform !== 'darwin')('weekend schedule lifecycle', () => {
  let fixture: string
  let application: string

  beforeEach(async () => {
    fixture = await realpath(await mkdtemp(join(tmpdir(), 'kudu-weekend-test-')))
    mocks.root = join(fixture, 'data')
    mocks.home = join(fixture, 'home')
    mocks.loaded = false
    mocks.failBootstrap = false
    application = join(fixture, 'An app & quotes".app')
    await mkdir(join(application, 'Contents'), { recursive: true })
    await writeFile(join(application, 'Contents', 'Info.plist'), '<plist/>')
  })
  afterEach(() => rm(fixture, { recursive: true, force: true }))

  it('creates an independent user agent, prevents duplicates, and removes only its own schedule', async () => {
    await addWeekendAppLaunch(application)
    const [entry] = await listWeekendAppLaunches()
    expect(entry.appPath).toBe(application)
    expect(entry.loaded).toBe(true)
    const agents = join(mocks.home, 'Library', 'LaunchAgents')
    const [file] = await readdir(agents)
    const agent = JSON.parse(await readFile(join(agents, file), 'utf8'))
    expect(agent.ProgramArguments.slice(0, 3)).toEqual(['/usr/bin/osascript', '-l', 'JavaScript'])
    expect(agent.RunAtLoad).toBe(true)
    expect(agent.StartInterval).toBe(300)
    await expect(addWeekendAppLaunch(application)).rejects.toThrow()
    await expect(removeWeekendAppLaunch('../../elsewhere')).rejects.toThrow('Invalid schedule ID')
    expect((await listWeekendAppLaunches()).length).toBe(1)
    await removeWeekendAppLaunch(entry.id)
    expect(await readdir(agents)).toEqual([])
    expect(await listWeekendAppLaunches()).toEqual([])
  })

  it('persists selected days, updates them, and preserves legacy schedules', async () => {
    await addWeekendAppLaunch(application, { days: [1, 3], frequency: 'daily' })
    let [entry] = await listWeekendAppLaunches()
    expect(entry.policy).toEqual({ days: [1, 3], frequency: 'daily' })
    await expect(
      updateWeekendAppLaunch(entry.id, { days: [], frequency: 'weekly' })
    ).rejects.toThrow()
    await updateWeekendAppLaunch(entry.id, { days: [5], frequency: 'weekly' })
    ;[entry] = await listWeekendAppLaunches()
    expect(entry.policy).toEqual({ days: [5], frequency: 'weekly' })
    const configPath = join(mocks.root, 'weekend-app-launches', entry.id, 'config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    delete config.policy
    await writeFile(configPath, JSON.stringify(config))
    expect((await listWeekendAppLaunches())[0].policy).toEqual({
      days: [6, 0],
      frequency: 'weekly'
    })
  })

  it('rolls back a failed registration so the application can be added again', async () => {
    mocks.failBootstrap = true
    await expect(addWeekendAppLaunch(application)).rejects.toThrow('bootstrap failed')
    expect(await listWeekendAppLaunches()).toEqual([])
    expect(await readdir(join(mocks.home, 'Library', 'LaunchAgents'))).toEqual([])
    mocks.failBootstrap = false
    await addWeekendAppLaunch(application)
    expect((await listWeekendAppLaunches()).length).toBe(1)
  })
})
