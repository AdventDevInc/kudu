const assert = require('node:assert/strict')
const { cp, mkdtemp, rm, writeFile } = require('node:fs/promises')
const path = require('node:path')
const { archive } = require('app-builder-lib/out/targets/archive')
const { Arch } = require('builder-util')

// Run after all targets finish: never add the marker to the app directory,
// which is shared with NSIS and portable. Use the actual built architectures.
module.exports = async function buildPortableZip(context) {
  const windows = [...context.platformToTargets].find(([platform]) => platform.nodeName === 'win32')
  const target = windows?.[1].get('nsis') || windows?.[1].get('portable')
  if (!target) return []

  const outDir = path.resolve(target.outDir)
  const version = target.packager.appInfo.version
  const outputs = []
  for (const [arch, appOutDir] of target.archs) {
    const output = path.join(outDir, `Kudu-Portable-${version}-${Arch[arch]}.zip`)
    const staging = await mkdtemp(path.join(outDir, 'portable-zip-'))
    try {
      await cp(appOutDir, staging, { recursive: true })
      await writeFile(path.join(staging, 'resources', 'portable.json'), '{"portable":true}\n')
      await archive('zip', output, staging, { withoutDir: true })
      outputs.push(output)
    } finally {
      assert.equal(path.dirname(staging), outDir)
      await rm(staging, { recursive: true, force: true })
    }
  }
  return outputs
}
