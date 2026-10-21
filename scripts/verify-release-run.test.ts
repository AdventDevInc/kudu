import { describe, expect, it } from 'vitest'
import { verifyReleaseRun } from './verify-release-run'

const repo = 'AdventDevInc/kudu'
const tag = 'v3.0.0'
const tagCommit = 'abc123'

function fixture() {
  return {
    run: {
      repository: { full_name: repo },
      head_repository: { full_name: repo },
      path: '.github/workflows/release.yml',
      status: 'completed',
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: 'recovery123'
    },
    jobs: [
      'Prepare Draft Release',
      ...[
        'windows-latest',
        'windows-11-arm',
        'macos-latest',
        'ubuntu-latest',
        'ubuntu-24.04-arm'
      ].map((runner) => `Build and Sign (${runner})`)
    ].map((name) => ({ name, conclusion: 'success' }))
  }
}

describe('release artifact recovery source', () => {
  it('accepts completed builds from the release recovery workflow on main', () => {
    const { run, jobs } = fixture()
    expect(() => verifyReleaseRun(run, jobs, repo, tag, tagCommit)).not.toThrow()
  })

  it('requires push builds to match the requested tag and commit', () => {
    const { run, jobs } = fixture()
    Object.assign(run, { event: 'push', head_branch: tag, head_sha: tagCommit })
    expect(() => verifyReleaseRun(run, jobs, repo, tag, tagCommit)).not.toThrow()
    run.head_sha = 'another-commit'
    expect(() => verifyReleaseRun(run, jobs, repo, tag, tagCommit)).toThrow('Artifacts must come')
  })

  it.each([
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { head_repository: { full_name: 'fork/kudu' } },
    { repository: { full_name: 'different/repository' } },
    { path: '.github/workflows/ci.yml' },
    { status: 'in_progress' }
  ])('rejects untrusted or incomplete sources: %j', (change) => {
    const { run, jobs } = fixture()
    expect(() => verifyReleaseRun({ ...run, ...change }, jobs, repo, tag, tagCommit)).toThrow()
  })

  it('requires every platform build and draft preparation to have succeeded', () => {
    const { run, jobs } = fixture()
    for (let i = 0; i < jobs.length; i++) {
      const failed = jobs.map((job, index) => ({
        ...job,
        conclusion: index === i ? 'failure' : 'success'
      }))
      expect(() => verifyReleaseRun(run, failed, repo, tag, tagCommit)).toThrow(
        'Source job must succeed'
      )
    }
    expect(() => verifyReleaseRun(run, jobs.slice(1), repo, tag, tagCommit)).toThrow(
      'Expected exactly one job'
    )
    expect(() => verifyReleaseRun(run, [...jobs, jobs[0]], repo, tag, tagCommit)).toThrow(
      'Expected exactly one job'
    )
  })
})
