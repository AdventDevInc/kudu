import { readFile } from 'fs/promises'
import { resolve } from 'path'

/** Decode the octal escapes /proc/self/mountinfo uses for spaces, tabs and newlines. */
const unescapeMountPath = (value: string): string =>
  value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))

/** Mount points listed in a mountinfo document (field 5), as resolved absolute paths. */
export function parseMountInfo(text: string): Set<string> {
  const points = new Set<string>()
  for (const line of text.split('\n')) {
    const fields = line.split(' ')
    if (fields.length > 4 && fields[4].startsWith('/'))
      points.add(resolve(unescapeMountPath(fields[4])))
  }
  return points
}

/**
 * Mount points currently visible to this process. Linux only: on other platforms an empty
 * set is returned because device-ID comparisons already reveal their mounts. Linux bind
 * mounts keep the source filesystem's st_dev and survive realpath(), so traversals that
 * must stay inside a chosen folder need this explicit list to avoid walking into them.
 */
export async function mountPoints(): Promise<Set<string>> {
  if (process.platform !== 'linux') return new Set()
  try {
    return parseMountInfo(await readFile('/proc/self/mountinfo', 'utf8'))
  } catch {
    // Without mountinfo callers fall back to device checks only.
    return new Set()
  }
}

export async function isMountPoint(path: string): Promise<boolean> {
  return (await mountPoints()).has(resolve(path))
}
