import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { getPath7za } from 'app-builder-lib/out/toolsets/7zip'
import { Arch } from 'builder-util'
import buildPortableZip from './build-portable-zip'

const directories: string[] = []
const exec = promisify(execFile)

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    expect(dirname(directory)).toBe(resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  }
})

describe('portable ZIP packaging', () => {
  it('archives the complete app with a marker without altering installer resources', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'kudu portable test '))
    directories.push(outDir)
    const resources = join(outDir, 'win-unpacked', 'resources')
    await mkdir(join(resources, 'app.asar.unpacked'), { recursive: true })
    await writeFile(join(outDir, 'win-unpacked', 'Kudu.exe'), 'signed executable')
    await writeFile(join(resources, 'app.asar'), 'app code')
    await writeFile(join(resources, 'app.asar.unpacked', 'native.node'), 'native dependency')
    const context = {
      platformToTargets: new Map([
        [
          { nodeName: 'win32' },
          new Map([
            [
              'nsis',
              {
                outDir,
                archs: new Map([[Arch.x64, join(outDir, 'win-unpacked')]]),
                packager: { appInfo: { version: '3.0.1' } }
              }
            ]
          ])
        ]
      ])
    }
    const [zip] = await buildPortableZip(context)
    expect(zip).toBe(join(outDir, 'Kudu-Portable-3.0.1-x64.zip'))
    for (const [file, contents] of [
      ['Kudu.exe', 'signed executable'],
      ['resources/app.asar', 'app code'],
      ['resources/app.asar.unpacked/native.node', 'native dependency'],
      ['resources/portable.json', '{"portable":true}\n']
    ]) {
      const { stdout } = await exec(await getPath7za(), ['e', '-so', zip, file])
      expect(stdout).toBe(contents)
    }
    await expect(readFile(join(resources, 'portable.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect((await readdir(outDir)).sort()).toEqual(['Kudu-Portable-3.0.1-x64.zip', 'win-unpacked'])
  }, 60000)

  it('does not create Windows archives for other platforms or unpacked-only builds', async () => {
    expect(await buildPortableZip({ platformToTargets: new Map() })).toEqual([])
    expect(
      await buildPortableZip({ platformToTargets: new Map([[{ nodeName: 'win32' }, new Map()]]) })
    ).toEqual([])
  })
})
