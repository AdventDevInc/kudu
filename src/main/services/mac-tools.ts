import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import si from 'systeminformation'
import {
  elevatedBatch,
  isDefaultsValue,
  readUserDefault,
  type DefaultsValue
} from '../platform/darwin/privacy'
import type { MacReading, MacToolAction, MacToolReport, MacVolume } from '../../shared/mac-tools'

const exec = promisify(execFile)
const directory = () => join(app.getPath('userData'), 'mac-tools')
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
export function requireMacTools(): void {
  if (process.platform !== 'darwin') throw new Error('These tools require macOS.')
}

async function output(cmd: string, args: string[], timeout = 15_000): Promise<string> {
  return (await exec(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 })).stdout.trim()
}

async function reading(label: string, work: () => Promise<string>): Promise<MacReading> {
  try {
    return { label, value: await work() }
  } catch (error) {
    return { label, value: String(error), error: true }
  }
}

export async function macVolumes(): Promise<MacVolume[]> {
  requireMacTools()
  const result: MacVolume[] = [{ path: '/', name: 'Macintosh HD (/)' }]
  for (const name of await readdir('/Volumes')) {
    const path = join('/Volumes', name)
    try {
      const resolved = await realpath(path)
      const [volume, parent] = await Promise.all([stat(resolved), stat('/Volumes')])
      if (resolved === path && volume.isDirectory() && volume.dev !== parent.dev)
        result.push({ path, name })
    } catch {
      /* a volume may disappear while the list is read */
    }
  }
  return result
}

export async function spotlightReport(): Promise<MacToolReport> {
  const volumes = await macVolumes()
  return {
    volumes,
    readings: await Promise.all(
      volumes.map((volume) =>
        reading(volume.name, () => output('/usr/bin/mdutil', ['-s', volume.path]))
      )
    )
  }
}

export async function batteryReport(): Promise<MacToolReport> {
  requireMacTools()
  const data = await si.battery()
  if (!data.hasBattery) return { readings: [{ label: 'batteryPresent', value: 'false' }] }
  const health =
    data.designedCapacity > 0 && data.maxCapacity > 0
      ? Math.min(100, (data.maxCapacity / data.designedCapacity) * 100)
      : null
  const readings: MacReading[] = [
    { label: 'charge', value: Number.isFinite(data.percent) ? String(data.percent) + ' %' : '—' },
    { label: 'cycles', value: data.cycleCount >= 0 ? String(data.cycleCount) : '—' },
    { label: 'health', value: health === null ? '—' : health.toFixed(1) + ' %' },
    {
      label: 'capacity',
      value: data.maxCapacity > 0 ? data.maxCapacity + ' ' + data.capacityUnit : '—'
    },
    {
      label: 'designCapacity',
      value: data.designedCapacity > 0 ? data.designedCapacity + ' ' + data.capacityUnit : '—'
    },
    {
      label: 'remaining',
      value: data.timeRemaining > 0 ? String(data.timeRemaining) + ' min' : '—'
    },
    { label: 'charging', value: String(data.isCharging) }
  ]
  readings.push(
    await reading('temperature', async () => {
      // Search both legacy and Golden Gate battery objects. Unknown values stay unavailable.
      const raw = await output('/usr/sbin/ioreg', ['-r', '-c', 'AppleSmartBattery'])
      const match = raw.match(/"Temperature"\s*[=:]\s*(\d+)/)
      const celsius = match ? Number(match[1]) / 100 : NaN
      return celsius >= 0 && celsius <= 70 ? celsius.toFixed(1) + ' °C' : '—'
    })
  )
  return { readings }
}

export type EnergySource = '-b' | '-c' | '-u'
type EnergyValues = Record<string, number>
export type EnergyState = Partial<Record<EnergySource, EnergyValues>>
const ENERGY_KEYS = ['sleep', 'displaysleep', 'lowpowermode'] as const

export function parseEnergy(text: string): EnergyState {
  const sources: Record<string, EnergySource> = {
    'Battery Power': '-b',
    'AC Power': '-c',
    'UPS Power': '-u'
  }
  const result: EnergyState = {}
  let current: EnergyValues | undefined
  for (const line of text.split('\n')) {
    const header = line.match(/^(.+):\s*$/)
    if (header) {
      const source = sources[header[1]]
      current = source ? (result[source] = {}) : undefined
    } else {
      const match = line.trim().match(/^(sleep|displaysleep|lowpowermode)\s+(\d+)$/)
      if (current && match) current[match[1]] = Number(match[2])
    }
  }
  return result
}

const readEnergy = async () => parseEnergy(await output('/usr/bin/pmset', ['-g', 'custom']))
interface EnergyBackup {
  before: EnergyState
  after: EnergyState
}
interface AnimationSetting {
  domain: string
  key: string
  before: DefaultsValue
  after: DefaultsValue
}
const ANIMATION_TARGETS = [
  ['com.apple.dock', 'autohide-time-modifier'],
  ['com.apple.dock', 'autohide-delay'],
  ['com.apple.dock', 'mineffect'],
  ['com.apple.dock', 'launchanim'],
  ['NSGlobalDomain', 'NSAutomaticWindowAnimationsEnabled'],
  ['NSGlobalDomain', 'NSWindowResizeTime']
]

async function saved<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(directory(), name + '.json'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function save(name: string, value: unknown): Promise<void> {
  await mkdir(directory(), { recursive: true, mode: 0o700 })
  const path = join(directory(), name + '.json')
  const temporary = path + '.' + randomUUID()
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function energyCommands(state: EnergyState) {
  return Object.entries(state)
    .map(([source, values]) => {
      if (!['-b', '-c', '-u'].includes(source)) throw new Error('Invalid power source in backup.')
      const args: string[] = [source]
      for (const [key, value] of Object.entries(values)) {
        if (
          !ENERGY_KEYS.includes(key as (typeof ENERGY_KEYS)[number]) ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 2147483647 ||
          (key === 'lowpowermode' && value > 1)
        )
          throw new Error('Invalid energy setting.')
        args.push(key, String(value))
      }
      return { cmd: '/usr/bin/pmset', args }
    })
    .filter((command) => command.args.length > 1)
}

function assertEnergyUnchanged(current: EnergyState, snapshot: EnergyBackup) {
  energyCommands(snapshot.before)
  energyCommands(snapshot.after)
  for (const [source, values] of Object.entries(snapshot.before)) {
    for (const [key, before] of Object.entries(values)) {
      const actual = current[source as EnergySource]?.[key]
      if (actual !== before && actual !== snapshot.after[source as EnergySource]?.[key]) {
        throw new Error('Energy settings changed outside Kudu. Review them before restoring.')
      }
    }
  }
}

export async function energyReport(): Promise<MacToolReport> {
  requireMacTools()
  const state = await readEnergy()
  if (Object.keys(state).length === 0)
    throw new Error('macOS did not return readable energy settings.')
  return {
    canRestore: !!(await saved('energy')),
    readings: Object.entries(state).map(([label, values]) => ({
      label,
      value: Object.entries(values)
        .map(([key, value]) => key + ' = ' + value)
        .join('\n')
    }))
  }
}

async function applyEnergy(profile: 'eco' | 'balanced' | 'restore') {
  const current = await readEnergy()
  const prior = await saved<EnergyBackup>('energy')
  if (prior) assertEnergyUnchanged(current, prior)
  if (profile === 'restore') {
    if (!prior) throw new Error('No energy backup is available.')
    await elevatedBatch(
      energyCommands(prior.before),
      'Kudu needs permission to restore your energy settings.'
    )
    await rm(join(directory(), 'energy.json'))
    return
  }
  const after: EnergyState = {}
  for (const [source, values] of Object.entries(current)) {
    const next: EnergyValues = {}
    for (const key of ENERGY_KEYS) {
      if (values[key] === undefined) continue
      if (key === 'displaysleep') next[key] = profile === 'eco' ? 5 : 10
      if (key === 'sleep') next[key] = profile === 'eco' ? 15 : 30
      if (key === 'lowpowermode') next[key] = profile === 'eco' && source === '-b' ? 1 : 0
    }
    if (Object.keys(next).length) after[source as EnergySource] = next
  }
  if (!Object.keys(after).length) throw new Error('No supported energy settings found.')
  await save('energy', { before: prior?.before ?? current, after })
  await elevatedBatch(energyCommands(after), 'Kudu needs permission to apply your energy profile.')
  const applied = await readEnergy()
  for (const [source, values] of Object.entries(after)) {
    for (const [key, value] of Object.entries(values)) {
      if (applied[source as EnergySource]?.[key] !== value)
        throw new Error(
          'macOS did not apply all energy settings. The saved settings remain available for restoration.'
        )
    }
  }
}

function animationCommands(settings: AnimationSetting[], restore: boolean) {
  return settings.map((setting, index) => {
    if (
      setting.domain !== ANIMATION_TARGETS[index]?.[0] ||
      setting.key !== ANIMATION_TARGETS[index]?.[1] ||
      !isDefaultsValue(setting.before) ||
      !isDefaultsValue(setting.after)
    )
      throw new Error('Invalid animation backup.')
    const value = restore ? setting.before : setting.after
    return {
      cmd: '/usr/bin/defaults',
      args:
        value === null
          ? ['delete', setting.domain, setting.key]
          : ['write', setting.domain, setting.key, '-' + value.type, value.value]
    }
  })
}

export async function animationReport(): Promise<MacToolReport> {
  requireMacTools()
  return {
    canRestore: !!(await saved('animations')),
    readings: await Promise.all(
      ANIMATION_TARGETS.map(([domain, key]) =>
        reading(key, async () => {
          const value = await readUserDefault(domain, key, false)
          return value ? value.value : 'default'
        })
      )
    )
  }
}

function equalDefault(left: DefaultsValue, right: DefaultsValue): boolean {
  if (left === null || right === null) return left === right
  if (['int', 'float'].includes(left.type) && ['int', 'float'].includes(right.type)) {
    return Number(left.value) === Number(right.value)
  }
  return left.type === right.type && left.value === right.value
}

async function applyAnimations(profile: 'fast' | 'reduced' | 'restore') {
  const prior = await saved<AnimationSetting[]>('animations')
  if (prior && prior.length !== ANIMATION_TARGETS.length)
    throw new Error('Invalid animation backup.')
  const current = await Promise.all(
    ANIMATION_TARGETS.map(([domain, key]) => readUserDefault(domain, key, false))
  )
  if (prior) {
    animationCommands(prior, false)
    prior.forEach((setting, index) => {
      if (
        !equalDefault(setting.before, current[index]) &&
        !equalDefault(setting.after, current[index])
      ) {
        throw new Error('Animation settings changed outside Kudu. Review them before restoring.')
      }
    })
  }
  if (profile === 'restore' && !prior) throw new Error('No animation backup is available.')
  const values: DefaultsValue[] = [
    { type: 'float', value: profile === 'fast' ? '0.2' : '0' },
    { type: 'float', value: '0' },
    { type: 'string', value: 'scale' },
    { type: 'bool', value: '0' },
    { type: 'bool', value: profile === 'fast' ? '1' : '0' },
    { type: 'float', value: profile === 'fast' ? '0.1' : '0' }
  ]
  const settings = ANIMATION_TARGETS.map(([domain, key], index) => ({
    domain,
    key,
    before: prior ? prior[index].before : current[index],
    after: values[index]
  }))
  if (profile !== 'restore') await save('animations', settings)
  const selected = profile === 'restore' ? prior! : settings
  for (const [index, command] of animationCommands(selected, profile === 'restore').entries()) {
    // A key already absent needs no deletion.
    if (command.args[0] === 'delete' && current[index] === null) continue
    await output(command.cmd, command.args)
  }
  if (profile === 'restore') await rm(join(directory(), 'animations.json'))
  // Dock reads its preferences on restart. Window settings apply to newly opened windows.
  await output('/usr/bin/killall', ['Dock']).catch(() => {})
}

let changing: Promise<unknown> = Promise.resolve()
export function applyMacTool(input: unknown): Promise<void> {
  const work = changing.then(async () => {
    requireMacTools()
    const action = input as MacToolAction
    if (action?.kind === 'spotlight') {
      const volume = (await macVolumes()).find((volume) => volume.path === action.volume)
      if (!volume) throw new Error('Choose a currently mounted local volume.')
      await elevatedBatch(
        [
          { cmd: '/usr/bin/mdutil', args: ['-i', 'on', volume.path] },
          { cmd: '/usr/bin/mdutil', args: ['-E', volume.path] }
        ],
        'Kudu needs permission to rebuild the selected Spotlight index.'
      )
    } else if (action?.kind === 'associations') {
      await output(
        LSREGISTER,
        ['-kill', '-r', '-domain', 'local', '-domain', 'system', '-domain', 'user'],
        120_000
      )
    } else if (
      action?.kind === 'energy' &&
      ['eco', 'balanced', 'restore'].includes(action.profile)
    ) {
      await applyEnergy(action.profile)
    } else if (
      action?.kind === 'animations' &&
      ['fast', 'reduced', 'restore'].includes(action.profile)
    ) {
      await applyAnimations(action.profile)
    } else throw new Error('Unsupported macOS action.')
  })
  changing = work.catch(() => {})
  return work
}
