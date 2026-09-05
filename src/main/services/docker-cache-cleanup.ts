import { homedir } from 'os'
import type { DockerCleanupTarget } from '../../shared/types'
import { execTracked } from './exec-utf8'

const options = { timeout: 10_000, cwd: homedir() }
const localEndpoint = (value: string): boolean =>
  /^unix:\/\/\/[^\r\n]+$/.test(value) || /^npipe:\/\/\/\/\.\/pipe\/[^\r\n]+$/.test(value)

function engineOptions() {
  // Pin the inspected local socket; environment overrides cannot redirect pruning.
  const env = { ...process.env }
  delete env.DOCKER_CONTEXT
  delete env.DOCKER_HOST
  delete env.DOCKER_TLS_VERIFY
  delete env.DOCKER_CERT_PATH
  return { ...options, env }
}

/** Inspect only. Never start Docker, build, prune, or connect to a remote engine. */
export async function discoverDockerCleanup(): Promise<DockerCleanupTarget> {
  const context = (await execTracked('docker', ['context', 'show'], options)).stdout.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(context)) throw new Error('Unsupported Docker context')
  const inspected = JSON.parse((await execTracked('docker', ['context', 'inspect', context], options)).stdout)
  const endpoint = inspected?.[0]?.Endpoints?.docker?.Host
  if (typeof endpoint !== 'string' || !localEndpoint(endpoint)) throw new Error('Docker cleanup requires a local engine')
  const daemonId = (await execTracked('docker', ['--host', endpoint, 'info', '--format', '{{.ID}}'], engineOptions())).stdout.trim()
  if (!daemonId || /\s/.test(daemonId)) throw new Error('Docker engine identity unavailable')
  return { context, endpoint, daemonId }
}

export async function pruneDockerBuildCache(target?: DockerCleanupTarget): Promise<void> {
  if (!target || !localEndpoint(target.endpoint)) throw new Error('Docker target missing; scan again.')
  const current = await discoverDockerCleanup()
  if (current.context !== target.context || current.endpoint !== target.endpoint || current.daemonId !== target.daemonId) {
    throw new Error('Docker engine changed; scan again.')
  }
  await execTracked('docker', [
    '--host', target.endpoint, 'builder', 'prune', '--force',
    '--filter', 'until=168h', '--keep-storage', '10GB',
  ], { ...engineOptions(), timeout: 300_000 })
}
