import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { dump, load } from 'js-yaml'
import {
  expectedAssetNames,
  verifyReleaseArtifacts,
  verifyUploadedAssets
} from './release-artifacts'

const tag = 'v2.9.0'
const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    expect(dirname(directory)).toBe(resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  }
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'kudu-release-test-'))
  directories.push(directory)
  const names = expectedAssetNames(tag)
  const targets = {
    'latest.yml': ['Kudu-Setup-2.9.0.exe'],
    'latest-mac.yml': [
      'Kudu-2.9.0-x64.dmg',
      'Kudu-2.9.0-x64.zip',
      'Kudu-2.9.0-arm64.dmg',
      'Kudu-2.9.0-arm64.zip'
    ],
    'latest-linux.yml': ['Kudu-x86_64.AppImage', 'Kudu-2.9.0-amd64.deb'],
    'latest-linux-arm64.yml': ['Kudu-arm64.AppImage', 'Kudu-2.9.0-arm64.deb']
  }
  for (const name of names.filter((name: string) => !name.endsWith('.yml'))) {
    await writeFile(join(directory, name), name)
  }
  for (const [name, files] of Object.entries(targets)) {
    const entries = files.map((url) => ({
      url,
      size: Buffer.byteLength(url),
      sha512: createHash('sha512').update(url).digest('base64')
    }))
    await writeFile(
      join(directory, name),
      dump({ version: '2.9.0', files: entries, path: entries[0].url, sha512: entries[0].sha512 })
    )
  }
  return directory
}

async function editManifest(directory: string, name: string, edit: (manifest: any) => void) {
  const file = join(directory, name)
  const manifest = load(await readFile(file, 'utf8'))
  edit(manifest)
  await writeFile(file, dump(manifest))
}

describe('release artifact verification', () => {
  it('accepts a complete release with all architecture manifests', async () => {
    const assets = await verifyReleaseArtifacts(await fixture(), tag)
    expect(assets).toHaveLength(19)
  })

  it('rejects a missing installer before publishing', async () => {
    const directory = await fixture()
    await rm(join(directory, 'Kudu-2.9.0-arm64.dmg'))
    await expect(verifyReleaseArtifacts(directory, tag)).rejects.toThrow('Missing release artifact')
  })

  it('rejects a missing architecture-specific update manifest', async () => {
    const directory = await fixture()
    await rm(join(directory, 'latest-linux-arm64.yml'))
    await expect(verifyReleaseArtifacts(directory, tag)).rejects.toThrow('latest-linux-arm64.yml')
  })

  it('rejects platform filename collisions instead of overwriting artifacts', async () => {
    const directory = await fixture()
    await mkdir(join(directory, 'arm64'))
    await writeFile(join(directory, 'arm64', 'latest-linux.yml'), 'duplicate')
    await expect(verifyReleaseArtifacts(directory, tag)).rejects.toThrow('Duplicate artifact')
  })

  it('rejects empty or unexpected artifacts', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'Kudu-Setup-2.9.0.exe'), '')
    await expect(verifyReleaseArtifacts(directory, tag)).rejects.toThrow('Empty artifact')
    await writeFile(join(directory, 'Kudu-Setup-2.9.0.exe'), 'Kudu-Setup-2.9.0.exe')
    await writeFile(join(directory, 'builder-effective-config.yaml'), 'not a release asset')
    await expect(verifyReleaseArtifacts(directory, tag)).rejects.toThrow(
      'Unexpected release artifact'
    )
  })

  it('rejects update metadata from a different version', async () => {
    const directory = await fixture()
    await editManifest(directory, 'latest.yml', (manifest) => {
      manifest.version = '2.8.0'
    })
    await expect(verifyReleaseArtifacts(directory, tag)).rejects.toThrow('wrong version')
  })

  it.each([
    'Kudu-x86_64.AppImage',
    '../Kudu-arm64.AppImage',
    'https://example.com/Kudu-arm64.AppImage'
  ])('rejects wrong-architecture or unsafe update target %s', async (url) => {
    const directory = await fixture()
    await editManifest(directory, 'latest-linux-arm64.yml', (manifest) => {
      manifest.files[0].url = url
    })
    await expect(verifyReleaseArtifacts(directory, tag)).rejects.toThrow('unexpected update target')
  })

  it('rejects a manifest pointing at a modified installer', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'Kudu-Setup-2.9.0.exe'), 'corrupted')
    await expect(verifyReleaseArtifacts(directory, tag)).rejects.toThrow('checksum mismatch')
  })

  it('checks both modern and legacy update metadata', async () => {
    const directory = await fixture()
    await editManifest(directory, 'latest.yml', (manifest) => {
      manifest.sha512 = 'bad'
    })
    await expect(verifyReleaseArtifacts(directory, tag)).rejects.toThrow('legacy checksum mismatch')
  })

  it('rejects an update manifest omitting one supported architecture', async () => {
    const directory = await fixture()
    await editManifest(directory, 'latest-mac.yml', (manifest) => {
      manifest.files.pop()
    })
    await expect(verifyReleaseArtifacts(directory, tag)).rejects.toThrow('missing update target')
  })

  it('checks manifest sizes and rejects duplicate entries', async () => {
    const directory = await fixture()
    await editManifest(directory, 'latest.yml', (manifest) => {
      manifest.files[0].size++
    })
    await expect(verifyReleaseArtifacts(directory, tag)).rejects.toThrow('size mismatch')
    await editManifest(directory, 'latest.yml', (manifest) => {
      manifest.files[0].size--
      manifest.files.push(manifest.files[0])
    })
    await expect(verifyReleaseArtifacts(directory, tag)).rejects.toThrow('duplicate update target')
  })

  it('requires uploaded assets to match local sizes and SHA256 digests', async () => {
    const assets = await verifyReleaseArtifacts(await fixture(), tag)
    const uploaded = assets.map((asset: any) => ({
      name: asset.name,
      size: asset.size,
      state: 'uploaded',
      digest: `sha256:${asset.sha256}`
    }))
    expect(() => verifyUploadedAssets(assets, uploaded)).not.toThrow()
    uploaded[0].digest = 'sha256:wrong'
    expect(() => verifyUploadedAssets(assets, uploaded)).toThrow('Uploaded checksum mismatch')
    expect(() => verifyUploadedAssets(assets, uploaded.slice(1))).toThrow(
      'number of uploaded assets'
    )
  })
})
