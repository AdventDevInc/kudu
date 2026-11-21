const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { existsSync, mkdtempSync, readFileSync } = require('node:fs')
const { rm } = require('node:fs/promises')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const path = require('node:path')

if (process.argv[2] === '--native') {
  // This branch runs inside the packaged Electron binary, using only modules
  // shipped in app.asar. It never resolves natives from the source checkout.
  assert(process.versions.electron, 'Native smoke test must use the packaged Electron runtime')
  assert.equal(
    process.arch,
    process.argv[4],
    'Packaged runtime must match the test host architecture'
  )
  const archive = process.argv[3]
  const packagedRequire = createRequire(path.join(archive, 'package.json'))
  for (const file of [
    'out/main/index.js',
    'out/main/yara-worker.js',
    'out/preload/index.js',
    'out/renderer/index.html'
  ]) {
    assert(readFileSync(path.join(archive, file)).length > 0, `Missing bundled file: ${file}`)
  }
  for (const name of ['better-sqlite3', '@litko/yara-x']) {
    assert(
      packagedRequire.resolve(name).startsWith(`${archive}${path.sep}`),
      `${name} resolved outside app.asar`
    )
  }
  const Database = packagedRequire('better-sqlite3')
  const db = new Database(':memory:')
  try {
    assert.equal(db.prepare('SELECT 42 AS answer').get().answer, 42)
  } finally {
    db.close()
  }
  const scanner = packagedRequire('@litko/yara-x').create()
  scanner.addRuleSource('rule PackagedSmoke { strings: $a = "kudu_package_probe" condition: $a }')
  assert.equal(scanner.scan(Buffer.from('kudu_package_probe'))[0]?.ruleIdentifier, 'PackagedSmoke')
  assert.equal(scanner.scan(Buffer.from('clean data')).length, 0)
  console.log('Packaged resources, SQLite, and YARA passed')
} else {
  runPackagedSmoke().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

async function runPackagedSmoke() {
  assert(process.argv[2], 'Usage: node scripts/package-smoke-test.js <packaged executable>')
  const executable = path.resolve(process.argv[2])
  const resources = path.join(path.dirname(executable), 'resources')
  assert(existsSync(executable), `Packaged executable missing: ${executable}`)
  for (const file of ['app.asar', 'icon.ico', 'icon.png']) {
    assert(existsSync(path.join(resources, file)), `Packaged resource missing: ${file}`)
  }
  const temporary = mkdtempSync(path.join(tmpdir(), 'kudu-package-smoke-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ASAR
  delete env.NODE_PATH
  if (process.platform === 'linux') {
    delete env.DISPLAY
    delete env.WAYLAND_DISPLAY
    delete env.WAYLAND_SOCKET
  }
  const run = (args, overrides = {}, expectedStatus = 0) => {
    const result = spawnSync(executable, args, {
      // Windows helpers can briefly outlive Electron and retain their cwd.
      // Keep that cwd outside the disposable user-data directory.
      cwd: tmpdir(),
      env: { ...env, ...overrides },
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    })
    assert.ifError(result.error)
    assert.equal(
      result.status,
      expectedStatus,
      `Packaged command failed: ${args.join(' ')}\n${result.stdout}\n${result.stderr}`
    )
    return result.stdout.trim()
  }
  try {
    console.log(
      run([__filename, '--native', path.join(resources, 'app.asar'), process.arch], {
        ELECTRON_RUN_AS_NODE: '1'
      })
    )
    // Linux CI lacks a configured sandbox helper. Omit Ozone/GPU flags so
    // this exercises Kudu's automatic headless bootstrap in packaged builds.
    const flags = process.platform === 'linux' ? ['--no-sandbox'] : []
    // Keep all CLI state in a disposable directory, including on developer machines.
    const cli = (...args) => run([...flags, `--kudu-data-dir=${temporary}`, '--cli', ...args])
    assert.match(cli('--version'), /Kudu v\d+\.\d+\.\d+/)
    assert.match(cli('--help'), /usage/i)
    JSON.parse(cli('config', '--json', 'get'))
    JSON.parse(cli('history', '--json', 'list'))
    const invalid = run(
      [...flags, `--kudu-data-dir=${temporary}`, '--cli', '--json', 'bogus-command-12345'],
      {},
      6
    )
    assert.equal(typeof JSON.parse(invalid).error, 'string')
    // A deliberately invalid key exits before starting cloud/network activity.
    assert.match(
      run([...flags, `--kudu-data-dir=${temporary}`, '--daemon', '--api-key', 'x'], {}, 1),
      /API key must be between 10 and 200 characters/
    )
    console.log('Packaged CLI smoke tests passed')
  } finally {
    // Only the directory returned by mkdtempSync is ever removed.
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
