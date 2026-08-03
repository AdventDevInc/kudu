#!/usr/bin/env node

const { execSync } = require('child_process')
const { readFileSync, writeFileSync } = require('fs')

const run = (cmd) => execSync(cmd, { stdio: 'inherit' })
const capture = (cmd) => execSync(cmd, { encoding: 'utf-8' }).trim()

const bump = process.argv[2]
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('Usage: npm run release -- patch|minor|major')
  process.exit(1)
}

// Ensure clean working tree
const status = capture('git status --porcelain')
if (status) {
  console.error('Error: working tree is not clean. Commit or stash changes first.')
  process.exit(1)
}

// Ensure on main branch
const branch = capture('git rev-parse --abbrev-ref HEAD')
if (branch !== 'main') {
  console.error(`Error: releases must be made from main branch (currently on ${branch})`)
  process.exit(1)
}

// Ensure up to date with remote
run('git fetch origin main')
const behind = capture('git rev-list HEAD..origin/main --count')
if (behind !== '0') {
  console.error('Error: local main is behind origin. Pull first.')
  process.exit(1)
}

// 1. Bump version (no git tag, no commit)
run(`npm version ${bump} --no-git-tag-version`)
const version = JSON.parse(readFileSync('package.json', 'utf-8')).version
const tag = `v${version}`
console.log(`\nBumped to ${tag}`)

// 2. Generate changelog
//
// Work out first which commits the angular preset is expected to render, so the
// check below can tell a broken generator apart from a release that genuinely
// has nothing to announce (1.44.1 was chore-only, and its bare header is
// correct). Only these types produce entries; chore/docs/style/test/ci do not.
const RENDERED_TYPES = /^(feat|fix|perf|revert)(\(.+\))?!?:/
const previousTag = capture('git describe --tags --abbrev=0 HEAD')
const subjects = capture(`git log ${previousTag}..HEAD --no-merges --format=%s`)
  .split('\n')
  .filter(Boolean)
const expectedEntries = subjects.filter((s) => RENDERED_TYPES.test(s))

const changelogBefore = readFileSync('CHANGELOG.md', 'utf-8')
run('npx conventional-changelog -p angular -i CHANGELOG.md -s')

// conventional-changelog exits 0 whether or not it found anything, so a broken
// generator is silent. It broke once when a transitive dependency hoisted a
// preset version the generator couldn't read, and four releases shipped with
// empty notes before anyone noticed. Fail loudly instead.
const changelogAfter = readFileSync('CHANGELOG.md', 'utf-8')
const added = changelogAfter.slice(0, changelogAfter.length - changelogBefore.length)
const wroteEntries = /^\s*[*-]\s+\S/m.test(added)

if (expectedEntries.length > 0 && !wroteEntries) {
  console.error(`\nError: changelog generation produced no entries for ${tag}.`)
  console.error(`${expectedEntries.length} commit(s) since ${previousTag} should have appeared:\n`)
  for (const s of expectedEntries) console.error(`  ${s}`)
  console.error('\nWhat was written instead:\n')
  console.error(added.trim() || '  (nothing)')
  console.error('\nThis usually means the changelog preset failed to load. Check that the')
  console.error('conventional-changelog-angular version hoisted to the top of node_modules')
  console.error('is the one conventional-changelog depends on:\n')
  console.error('  npm ls conventional-changelog-angular\n')
  console.error('Nothing has been committed or pushed; reverting the version bump.')
  writeFileSync('CHANGELOG.md', changelogBefore)
  run('git checkout -- package.json package-lock.json')
  process.exit(1)
}

if (expectedEntries.length === 0) {
  console.log(`Changelog updated (no user-facing commits since ${previousTag})`)
} else {
  console.log(`Changelog updated (${expectedEntries.length} entr${expectedEntries.length === 1 ? 'y' : 'ies'})`)
}

// 3. Commit and tag
run('git add package.json package-lock.json CHANGELOG.md')
run(`git commit -m "chore(release): ${version}"`)
run(`git tag ${tag}`)

// 4. Push commit and tag
run('git push origin main')
run(`git push origin ${tag}`)

console.log(`\n${tag} released! CI will build and publish.`)
console.log(`Track progress: https://github.com/AdventDevInc/kudu/actions/workflows/release.yml`)
