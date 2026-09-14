const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { readdir, readFile, stat } = require('node:fs/promises')
const path = require('node:path')
const yaml = require('js-yaml')

function releaseVersion(tag) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/, 'Expected a stable release tag, e.g. v2.9.0')
  return tag.slice(1)
}

function manifestTargets(version) {
  return {
    'latest.yml': [`Kudu-Setup-${version}.exe`],
    'latest-mac.yml': ['x64', 'arm64'].flatMap((arch) => [
      `Kudu-${version}-${arch}.dmg`,
      `Kudu-${version}-${arch}.zip`
    ]),
    // Our pinned electron-builder includes DEBs in Linux update metadata too.
    'latest-linux.yml': ['Kudu-x86_64.AppImage', `Kudu-${version}-amd64.deb`],
    'latest-linux-arm64.yml': ['Kudu-arm64.AppImage', `Kudu-${version}-arm64.deb`]
  }
}

function expectedAssetNames(tag) {
  const version = releaseVersion(tag)
  const manifests = manifestTargets(version)
  const installers = Object.values(manifests).flat()
  return [
    ...installers,
    `Kudu-Portable-${version}.exe`,
    `Kudu-Portable-${version}-x64.zip`,
    ...installers.filter((name) => /\.(exe|dmg|zip)$/.test(name)).map((name) => `${name}.blockmap`),
    ...Object.keys(manifests)
  ]
}

async function collectAssets(directory, assets = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectAssets(file, assets)
    } else {
      assert(entry.isFile(), `Unexpected non-file artifact: ${file}`)
      assert(!assets.has(entry.name), `Duplicate artifact across platforms: ${entry.name}`)
      const { size } = await stat(file)
      assert(size > 0, `Empty artifact: ${entry.name}`)
      const sha256 = createHash('sha256')
      const sha512 = createHash('sha512')
      for await (const chunk of createReadStream(file)) {
        sha256.update(chunk)
        sha512.update(chunk)
      }
      assets.set(entry.name, {
        name: entry.name,
        path: file,
        size,
        sha256: sha256.digest('hex'),
        sha512: sha512.digest('base64')
      })
    }
  }
  return assets
}

async function verifyReleaseArtifacts(directory, tag) {
  const version = releaseVersion(tag)
  const assets = await collectAssets(directory)
  const expected = expectedAssetNames(tag)
  for (const name of expected) assert(assets.has(name), `Missing release artifact: ${name}`)
  // Optional external AppImage blockmaps vary with electron-builder versions.
  const allowed = new Set([
    ...expected,
    'Kudu-x86_64.AppImage.blockmap',
    'Kudu-arm64.AppImage.blockmap'
  ])
  for (const name of assets.keys())
    assert(allowed.has(name), `Unexpected release artifact: ${name}`)

  for (const [name, targets] of Object.entries(manifestTargets(version))) {
    const manifest = yaml.load(await readFile(assets.get(name).path, 'utf8'))
    assert.equal(manifest?.version, version, `${name}: wrong version`)
    assert(Array.isArray(manifest.files) && manifest.files.length > 0, `${name}: missing files`)
    const seen = new Set()
    for (const file of manifest.files) {
      assert(typeof file.url === 'string', `${name}: missing file URL`)
      const target = decodeURIComponent(file.url)
      assert(targets.includes(target), `${name}: unexpected update target ${target}`)
      assert(!seen.has(target), `${name}: duplicate update target ${target}`)
      seen.add(target)
      const asset = assets.get(target)
      assert.equal(file.sha512, asset.sha512, `${name}: checksum mismatch for ${target}`)
      assert.equal(file.size, asset.size, `${name}: size mismatch for ${target}`)
    }
    for (const target of targets)
      assert(seen.has(target), `${name}: missing update target ${target}`)
    assert(typeof manifest.path === 'string', `${name}: missing legacy update path`)
    const legacyTarget = decodeURIComponent(manifest.path)
    assert(targets.includes(legacyTarget), `${name}: invalid legacy update path`)
    assert.equal(
      manifest.sha512,
      assets.get(legacyTarget).sha512,
      `${name}: legacy checksum mismatch`
    )
  }
  return [...assets.values()]
}

function verifyUploadedAssets(localAssets, remoteAssets) {
  assert.equal(remoteAssets.length, localAssets.length, 'Unexpected number of uploaded assets')
  for (const local of localAssets) {
    const matches = remoteAssets.filter((remote) => remote.name === local.name)
    assert.equal(matches.length, 1, `Missing or duplicate uploaded artifact: ${local.name}`)
    const remote = matches[0]
    assert.equal(remote.state, 'uploaded', `Upload incomplete: ${local.name}`)
    assert.equal(remote.size, local.size, `Uploaded size mismatch: ${local.name}`)
    assert.equal(
      remote.digest,
      `sha256:${local.sha256}`,
      `Uploaded checksum mismatch: ${local.name}`
    )
  }
}

module.exports = {
  releaseVersion,
  expectedAssetNames,
  verifyReleaseArtifacts,
  verifyUploadedAssets
}
