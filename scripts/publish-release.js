const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { verifyReleaseArtifacts, verifyUploadedAssets } = require('./release-artifacts')

function findRelease(gh, repo, tag) {
  // GitHub's tag endpoint excludes drafts. List releases with authentication,
  // then use the stable release ID for all subsequent publication checks.
  const releases = gh(
    'api',
    '--paginate',
    `repos/${repo}/releases?per_page=100`,
    '--jq',
    '.[] | {id, tag_name, draft} | @json'
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const matches = releases.filter((release) => release.tag_name === tag)
  assert.equal(matches.length, 1, `Expected exactly one release for ${tag}`)
  return matches[0]
}

async function main() {
  const tag = process.env.TAG_NAME
  const repo = process.env.GITHUB_REPOSITORY
  assert(repo, 'GITHUB_REPOSITORY is required')
  const assets = await verifyReleaseArtifacts(process.argv[2], tag)
  console.log(`Verified ${assets.length} artifacts, including all five update manifests`)
  const gh = (...args) =>
    execFileSync('gh', args, { encoding: 'utf8', timeout: 20 * 60 * 1000 }).trim()
  const { id } = findRelease(gh, repo, tag)
  const getRelease = () => JSON.parse(gh('api', `repos/${repo}/releases/${id}`))
  const release = getRelease()
  assert(release.draft, `Release ${tag} is already public; refusing to replace its assets`)
  gh('release', 'upload', tag, '--repo', repo, '--clobber', ...assets.map((asset) => asset.path))
  const uploaded = JSON.parse(
    gh('api', '--paginate', '--slurp', `repos/${repo}/releases/${release.id}/assets?per_page=100`)
  ).flat()
  verifyUploadedAssets(assets, uploaded)
  assert(getRelease().draft, 'Release was published before verification completed')
  // Let GitHub select Latest by release date and semantic version. Forcing
  // --latest would let an older, slower pipeline displace a newer release.
  gh(
    'api',
    '--method',
    'PATCH',
    `repos/${repo}/releases/${release.id}`,
    '-F',
    'draft=false',
    '-f',
    'make_latest=legacy'
  )
  assert.equal(getRelease().draft, false, 'Release publication was not confirmed')
  console.log(`Published ${tag} after verifying every uploaded artifact checksum`)
}

module.exports = { findRelease }

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
