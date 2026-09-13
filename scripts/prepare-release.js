const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const tag = process.env.TAG_NAME
assert.match(tag, /^v\d+\.\d+\.\d+$/, 'Expected a stable release tag')
assert.equal(`v${require('../package.json').version}`, tag, 'Tag must match package.json')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
assert.equal(
  git('rev-parse', 'HEAD'),
  git('rev-parse', `${tag}^{commit}`),
  'Checkout must match tag'
)
git('merge-base', '--is-ancestor', 'HEAD', 'origin/main')

const repo = process.env.GITHUB_REPOSITORY
assert(repo, 'GITHUB_REPOSITORY is required')
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim()
// Listing (rather than treating every failed lookup as a 404) fails closed on API errors.
const releases = gh(
  'api',
  '--paginate',
  `repos/${repo}/releases?per_page=100`,
  '--jq',
  '.[] | {tag_name, draft} | @json'
)
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const existing = releases.find((release) => release.tag_name === tag)
if (existing) {
  assert(existing.draft, `Release ${tag} is already public; refusing to replace its assets`)
  console.log(`Reusing draft ${tag}`)
} else {
  const log = readFileSync(path.join(__dirname, '../CHANGELOG.md'), 'utf8')
  const version = tag.slice(1)
  const section = log
    .split(/^(?=##? \[)/m)
    .find((text) => text.startsWith(`## [${version}]`) || text.startsWith(`# [${version}]`))
  assert(section, `Missing CHANGELOG.md section for ${tag}`)
  const notesFile = path.join(process.env.RUNNER_TEMP, 'kudu-release-notes.md')
  writeFileSync(notesFile, section.replace(/^##? .+\n+/, '').trim())
  gh(
    'release',
    'create',
    tag,
    '--repo',
    repo,
    '--verify-tag',
    '--draft',
    '--title',
    tag,
    '--notes-file',
    notesFile
  )
  console.log(`Created draft ${tag}`)
}
