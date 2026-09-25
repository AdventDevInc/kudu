import { createHash, randomBytes } from 'crypto'
import { realpath } from 'fs/promises'
import { resolve } from 'path'
import { isAdmin } from './elevation'
import { execNativeUtf8, execTracked, psUtf8 } from './exec-utf8'

/**
 * Integrity seals for the registry backups Kudu may later import.
 *
 * Packaged Windows builds run elevated, but the backup folder defaults to the
 * user's Documents, which any unelevated process of that user can write. A
 * backup is only restorable when the SHA-256 of its exact bytes matches the one
 * Kudu recorded when writing it, in a key only administrators can change:
 * `HKLM\SOFTWARE\Kudu\RegistryBackupSeals\<folder id>` (value name = backup file
 * name). The folder id is derived from the backup folder's real path, so each
 * folder has its own seals: switching the backup folder never makes the seals
 * of backups left in the previous one look orphaned.
 *
 * Seals are read from HKLM only, never from the backup folder or userData.
 * Sealing needs elevation; when it is not possible the backup is still written
 * but cannot be restored from inside Kudu. Nothing here throws into the caller.
 */

const SEAL_ROOT = 'HKLM\\SOFTWARE\\Kudu\\RegistryBackupSeals'
/** File names only: no separators, no `..`, nothing cmd.exe or reg.exe would reinterpret. */
const SEALABLE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}\.reg$/
const SHA256_HEX = /^[0-9a-f]{64}$/

function isSealable(name: unknown): name is string {
  return typeof name === 'string' && SEALABLE_NAME.test(name) && !name.includes('..')
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The seal key for backups in `dir`: a subkey named after a hash of the folder's
 * real path (junctions resolved, case-folded), so the same folder always maps
 * to the same key however it is spelled.
 */
export async function sealKeyFor(dir: string): Promise<string> {
  let real: string
  try {
    real = await realpath(dir)
  } catch {
    real = resolve(dir)
  }
  const id = createHash('sha256').update(real.toLowerCase(), 'utf8').digest('hex').slice(0, 32)
  return `${SEAL_ROOT}\\${id}`
}

/** Record the hash of `bytes` as the seal for `fileName` in `dir`. False when it could not be recorded. */
export async function sealBackup(dir: string, fileName: string, bytes: Buffer): Promise<boolean> {
  if (process.platform !== 'win32' || !isSealable(fileName) || !isAdmin()) return false
  try {
    await execNativeUtf8(
      'reg',
      [
        'add',
        await sealKeyFor(dir),
        '/v',
        fileName,
        '/t',
        'REG_SZ',
        '/d',
        sha256Hex(bytes),
        '/f',
        '/reg:64'
      ],
      { timeout: 15000, windowsHide: true }
    )
    return true
  } catch {
    return false
  }
}

/** Parse `reg query` output into lower-cased file name → hash. Unexpected lines are ignored. */
function parseSeals(stdout: string): Map<string, string> {
  const seals = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_SZ\s+(\S+)\s*$/.exec(line)
    if (match && isSealable(match[1]) && SHA256_HEX.test(match[2]!.toLowerCase()))
      seals.set(match[1]!.toLowerCase(), match[2]!.toLowerCase())
  }
  return seals
}

/** Every seal recorded for `dir`, keyed by lower-cased file name. Empty when none can be read. */
export async function readSeals(dir: string): Promise<Map<string, string>> {
  if (process.platform !== 'win32') return new Map()
  try {
    const { stdout } = await execNativeUtf8('reg', ['query', await sealKeyFor(dir), '/reg:64'], {
      timeout: 15000,
      windowsHide: true
    })
    return parseSeals(stdout)
  } catch {
    return new Map()
  }
}

/** The recorded hash for `fileName` in `dir`, or null when there is none or it cannot be read. */
export async function readSeal(dir: string, fileName: string): Promise<string | null> {
  if (process.platform !== 'win32' || !isSealable(fileName)) return null
  try {
    const { stdout } = await execNativeUtf8(
      'reg',
      ['query', await sealKeyFor(dir), '/v', fileName, '/reg:64'],
      { timeout: 15000, windowsHide: true }
    )
    return parseSeals(stdout).get(fileName.toLowerCase()) ?? null
  } catch {
    return null
  }
}

/** True only when `bytes` hash to the seal recorded for `fileName` in `dir`. */
export async function verifySeal(dir: string, fileName: string, bytes: Buffer): Promise<boolean> {
  const seal = await readSeal(dir, fileName)
  return seal !== null && seal === sha256Hex(bytes)
}

/** Remove the seal of a deleted backup in `dir`. Best effort. */
export async function removeSeal(dir: string, fileName: string): Promise<void> {
  if (process.platform !== 'win32' || !isSealable(fileName) || !isAdmin()) return
  try {
    await execNativeUtf8(
      'reg',
      ['delete', await sealKeyFor(dir), '/v', fileName, '/f', '/reg:64'],
      { timeout: 15000, windowsHide: true }
    )
  } catch {
    // Best effort; `sweepSeals` retries once the file is gone.
  }
}

/**
 * Remove the seals of backups deleted from `dir`, reading the seal list once so
 * files that were never sealed cost no reg.exe call. Call it after deleting the
 * files. Best effort.
 */
export async function removeSeals(dir: string, fileNames: string[]): Promise<void> {
  if (process.platform !== 'win32' || !fileNames.length || !isAdmin()) return
  const seals = await readSeals(dir)
  for (const name of fileNames) if (seals.has(name.toLowerCase())) await removeSeal(dir, name)
}

/**
 * Drop every seal of `dir` whose backup file no longer exists there. `seals` is
 * `readSeals(dir)`, and `present` the lower-cased names of the regular files in
 * `dir`, listed *after* `seals` was read: Kudu always writes a backup before
 * sealing it, so a seal read earlier than the listing can never belong to a file
 * not yet written. Other folders' seals are never touched.
 *
 * Without this, a backup deleted outside Kudu (or whose seal removal failed)
 * could be put back later, byte for byte, by an unelevated process and be
 * verified again. Returns the seals that remain. Needs elevation to remove.
 */
export async function sweepSeals(
  dir: string,
  seals: Map<string, string>,
  present: Set<string>
): Promise<Map<string, string>> {
  const kept = new Map<string, string>()
  for (const [name, hash] of seals) {
    if (present.has(name)) kept.set(name, hash)
    else if (process.platform === 'win32' && isAdmin()) await removeSeal(dir, name)
  }
  return kept
}

/**
 * Create an empty directory that only Administrators and SYSTEM can modify, for
 * the `reg export` parts a sealed backup is assembled from and the copy `reg
 * import` reads. The user's %TEMP% will not do: an unelevated process could
 * rewrite a file there between Kudu writing (or hashing) it and reading it.
 *
 * The directory lives in the Windows temp folder, where standard users cannot
 * delete or rename other users' entries, has an unguessable name, is created
 * with a protected ACL in one call, and has its owner's implicit rights reduced
 * to read (OWNER RIGHTS). The ACL is read back and checked before use.
 * Rejects when not elevated or when any of that fails.
 */
export async function createPrivateTempDir(prefix: string): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Private temp folders are Windows-only')
  if (!/^[a-z][a-z-]{0,30}$/.test(prefix)) throw new Error('Invalid temp folder prefix')
  if (!isAdmin()) throw new Error('A private temp folder needs administrator privileges')
  const name = prefix + randomBytes(16).toString('hex')
  const script =
    "$ErrorActionPreference='Stop'; " +
    `$p=Join-Path (Join-Path ([Environment]::GetFolderPath('Windows')) 'Temp') '${name}'; ` +
    "$full=[Security.AccessControl.FileSystemRights]'FullControl'; " +
    "$read=[Security.AccessControl.FileSystemRights]'ReadAndExecute, Synchronize'; " +
    "$inh=[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'; " +
    "$rules=@(@('S-1-5-32-544',$full),@('S-1-5-18',$full),@('S-1-3-4',$read)); " +
    '$s=New-Object Security.AccessControl.DirectorySecurity; ' +
    '$s.SetAccessRuleProtection($true,$false); ' +
    'foreach ($r in $rules) { $s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($r[0])),$r[1],$inh,' +
    "[Security.AccessControl.PropagationFlags]'None',[Security.AccessControl.AccessControlType]'Allow'))) }; " +
    "if ([IO.Directory]::Exists($p)) { throw 'Temp folder already exists' }; " +
    '[void][IO.Directory]::CreateDirectory($p,$s); ' +
    '$a=[IO.Directory]::GetAccessControl($p); ' +
    "if (-not $a.AreAccessRulesProtected) { throw 'Temp folder inherits permissions' }; " +
    'foreach ($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { ' +
    '$id=$r.IdentityReference.Value; ' +
    "if ($r.AccessControlType -ne 'Allow') { continue }; " +
    "if ($id -eq 'S-1-3-4') { if ([int]($r.FileSystemRights -band (-bnot $read)) -ne 0) { throw 'Temp folder owner can write' } } " +
    "elseif (@('S-1-5-32-544','S-1-5-18') -notcontains $id) { throw 'Temp folder grants access to ' + $id } }; " +
    "if (@(Get-ChildItem -LiteralPath $p -Force).Count -ne 0) { throw 'Temp folder is not empty' }; " +
    '[Console]::Out.Write($p)'
  const { stdout } = await execTracked(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)],
    { timeout: 20000, windowsHide: true }
  )
  const path = stdout.trim()
  if (!/^[A-Za-z]:\\/.test(path) || !path.toLowerCase().endsWith(`\\temp\\${name}`))
    throw new Error('Could not create a private temp folder')
  return path
}
