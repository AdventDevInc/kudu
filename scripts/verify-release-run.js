const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')

function verifyReleaseRun(run, jobs, repo, tag, tagCommit) {
  assert.equal(run.repository.full_name, repo, 'Artifact run must belong to this repository')
  assert.equal(run.head_repository.full_name, repo, 'Fork artifacts cannot be published')
  assert.equal(run.path, '.github/workflows/release.yml', 'Expected the release workflow')
  assert.equal(run.status, 'completed', 'Artifact run must be completed')
  assert(
    (run.event === 'push' && run.head_branch === tag && run.head_sha === tagCommit) ||
      (run.event === 'workflow_dispatch' && run.head_branch === 'main'),
    'Artifacts must come from a tag release or a main-branch release recovery'
  )
  for (const name of [
    'Prepare Draft Release',
    ...[
      'windows-latest',
      'windows-11-arm',
      'macos-latest',
      'ubuntu-latest',
      'ubuntu-24.04-arm'
    ].map((runner) => `Build and Sign (${runner})`)
  ]) {
    const matches = jobs.filter((job) => job.name === name)
    assert.equal(matches.length, 1, `Expected exactly one job: ${name}`)
    assert.equal(matches[0].conclusion, 'success', `Source job must succeed: ${name}`)
  }
}

function main() {
  const { ARTIFACT_RUN_ID: id, GITHUB_REPOSITORY: repo, RELEASE_TAG: tag } = process.env
  assert.match(id, /^\d+$/, 'Expected a numeric artifact run ID')
  assert.match(tag, /^v\d+\.\d+\.\d+$/, 'Expected a stable release tag')
  const gh = (...args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }))
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  const run = gh('api', `repos/${repo}/actions/runs/${id}`)
  const pages = gh(
    'api',
    '--paginate',
    '--slurp',
    `repos/${repo}/actions/runs/${id}/jobs?per_page=100`
  )
  verifyReleaseRun(
    run,
    pages.flatMap((page) => page.jobs),
    repo,
    tag,
    git('rev-parse', `${tag}^{commit}`)
  )
  // A dispatch may only reuse builds from code already on the trusted main
  // history. Artifact versions, completeness and checksums are checked again
  // by publish-release.js; no release verification is skipped during recovery.
  git('merge-base', '--is-ancestor', run.head_sha, 'origin/main')
  console.log(`Verified successful platform builds from release run ${id}`)
}

module.exports = { verifyReleaseRun }

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
