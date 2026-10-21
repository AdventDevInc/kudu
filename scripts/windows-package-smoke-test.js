const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, mkdtempSync, readFileSync } = require('node:fs')
const { rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const yaml = require('js-yaml')
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip')

async function main() {
  // Installing/uninstalling changes registry state. Run only on disposable hosted CI.
  assert.equal(process.platform, 'win32')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert(['x64', 'arm64'].includes(process.arch))
  const version = require('../package.json').version
  const suffix = process.arch === 'arm64' ? '-arm64' : ''
  const channel = `latest${suffix}`
  const installerName = `Kudu-Setup-${version}${suffix}.exe`
  const installer = path.resolve('dist', installerName)
  const manifest = yaml.load(readFileSync(path.resolve('dist', `${channel}.yml`), 'utf8'))
  assert.equal(manifest.version, version)
  assert.equal(manifest.path, installerName)
  assert.deepEqual(
    manifest.files.map((file) => file.url),
    [installerName]
  )
  const contents = readFileSync(installer)
  assert.equal(manifest.files[0].sha512, createHash('sha512').update(contents).digest('base64'))
  assert.equal(manifest.files[0].size, contents.length)

  const temporary = mkdtempSync(path.join(tmpdir(), 'kudu-windows-smoke-'))
  const installed = path.join(temporary, 'installed')
  const portable = path.join(temporary, 'portable')
  const run = (file, args) => {
    const result = spawnSync(file, args, {
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${file}: ${result.stdout}\n${result.stderr}`)
  }
  const smoke = (directory, isPortable) => {
    const resources = path.join(directory, 'resources')
    assert.equal(existsSync(path.join(resources, 'portable.json')), isPortable)
    const config = yaml.load(readFileSync(path.join(resources, 'app-update.yml'), 'utf8'))
    assert.equal(config.channel || 'latest', channel, 'Wrong packaged update channel')
    run(process.execPath, [
      path.resolve(__dirname, 'package-smoke-test.js'),
      path.join(directory, 'Kudu.exe')
    ])
  }
  try {
    run(installer, ['/S', `/D=${installed}`])
    smoke(installed, false)
    // Reinstall through the same NSIS path used by the updater, retaining native architecture.
    run(installer, ['/S', '--updated', `/D=${installed}`])
    smoke(installed, false)
    const zip = path.resolve('dist', `Kudu-Portable-${version}-${process.arch}.zip`)
    run(await getPath7za(), ['x', zip, `-o${portable}`, '-y'])
    smoke(portable, true)
    console.log(
      `Windows ${process.arch} install, reinstall, update metadata, and portable ZIP passed`
    )
  } finally {
    const uninstaller = path.join(installed, 'Uninstall Kudu.exe')
    if (existsSync(uninstaller)) run(uninstaller, ['/S', `_?=${installed}`])
    assert.equal(path.dirname(temporary), path.resolve(tmpdir()))
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
