import { readFile } from 'fs/promises'
import { posix } from 'path'
import { execTracked, psUtf8 } from './exec-utf8'

const LOCAL_LINUX_TYPES = new Set([
  'ext2',
  'ext3',
  'ext4',
  'xfs',
  'btrfs',
  'zfs',
  'f2fs',
  'jfs',
  'reiserfs',
  'nilfs2',
  'bcachefs',
  'vfat',
  'msdos',
  'exfat',
  'ntfs',
  'ntfs3',
  'hfs',
  'hfsplus',
  'ufs',
  'tmpfs',
  'ramfs',
  'overlay'
])
const decodeMountPath = (path: string): string =>
  path.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))
type Mount = { path: string; local: boolean }

/** Use the most specific containing mount, including the target mount itself.
 * Ambiguous stacked mounts fail closed unless every candidate is local.
 */
function onLocalMount(path: string, mounts: Mount[]): boolean {
  const target = posix.resolve(path)
  const containing = mounts.filter(
    (mount) =>
      target === mount.path || target.startsWith(mount.path === '/' ? '/' : mount.path + '/')
  )
  const longest = Math.max(...containing.map((mount) => mount.path.length))
  const selected = containing.filter((mount) => mount.path.length === longest)
  return selected.length > 0 && selected.every((mount) => mount.local)
}

export function onLocalLinuxFilesystem(path: string, mountinfo: string): boolean {
  const mounts: Mount[] = []
  for (const line of mountinfo.split('\n')) {
    const [left, right] = line.split(' - ')
    if (!right) continue
    const fields = left.split(' ')
    if (fields.length < 6 || !fields[4].startsWith('/')) continue
    const [type, source] = right.split(' ')
    // FUSE's generic magic cannot establish locality. Only the block-device
    // variant backed by /dev is allowed (commonly local NTFS/exFAT volumes).
    const local = LOCAL_LINUX_TYPES.has(type) || (type === 'fuseblk' && source?.startsWith('/dev/'))
    mounts.push({ path: posix.normalize(decodeMountPath(fields[4])), local })
  }
  return onLocalMount(path, mounts)
}

export function onLocalMacFilesystem(path: string, output: string): boolean {
  const mounts: Mount[] = []
  for (const line of output.split('\n')) {
    const match = line.match(/ on (\/.*) \(([^)]+)\)$/)
    if (!match) continue
    const flags = match[2].split(',').map((flag) => flag.trim())
    mounts.push({
      path: posix.normalize(decodeMountPath(match[1])),
      local: flags.includes('local') && ['apfs', 'hfs', 'msdos', 'exfat', 'ufs'].includes(flags[0])
    })
  }
  return onLocalMount(path, mounts)
}

/** Refresh for every add, scan and cleanup operation; never trust a saved drive letter.
 * Unavailable/unknown filesystem metadata rejects the operation before any claim.
 */
export async function assertLocalCustomFilesystem(
  path: string,
  platform = process.platform
): Promise<void> {
  let local = false
  if (platform === 'win32') {
    const drive = path.match(/^([A-Za-z]):[\\/]/)?.[1]
    if (!drive) throw new Error('Choose a drive-qualified local folder.')
    // Only a validated drive letter enters PowerShell, never the user-supplied path.
    const { stdout } = await execTracked(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        psUtf8(`[int]([System.IO.DriveInfo]::new('${drive}:\\').DriveType)`)
      ],
      { timeout: 10000 }
    )
    local = ['2', '3', '6'].includes(stdout.trim()) // Removable, Fixed, RAM; reject Network/Unknown.
  } else if (platform === 'linux') {
    local = onLocalLinuxFilesystem(path, await readFile('/proc/self/mountinfo', 'utf8'))
  } else if (platform === 'darwin') {
    const { stdout } = await execTracked('/sbin/mount', [], { timeout: 10000 })
    local = onLocalMacFilesystem(path, stdout)
  }
  if (!local)
    throw new Error(
      'Choose a verified local filesystem. Network and unknown filesystems are not supported.'
    )
}
