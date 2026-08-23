# Kudu

A modern, open-source system cleaner for Windows, macOS, and Linux built with Electron.

## Releasing

All releases are done via a single command:

```
npm run release -- patch|minor|major
```

This handles everything: version bump, changelog generation, commit, tag, push, and triggers CI to build and publish.

`conventional-changelog-angular` is pinned to `^8` as a direct devDependency even
though nothing imports it. This is deliberate: commitlint depends on `^9`, which
npm hoists to the top of `node_modules`, where `conventional-changelog`'s preset
loader picks it up instead of the `^8` it needs — and v9 exports a shape v8's
loader can't read, so changelog generation silently produces empty sections.
Pinning `^8` as a direct dependency keeps the right version hoisted and pushes
commitlint's copy into a nested folder. Don't remove it as unused. `npm ls
conventional-changelog-angular` should show `8.x` at the top level.

## Testing

```
npm test              # run all tests once (vitest run)
npm run test:watch    # run tests in watch mode
npm run validate:rules # validate rule JSON files against schema
```

## Development

```
npm run dev
```

## Commit Conventions

Always use [Conventional Commits](https://www.conventionalcommits.org/). Format:

```
<type>(<scope>): <short summary>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.

Examples:
- `feat(rules): add new browser cache cleaning rule`
- `fix(scanner): handle missing registry keys on Windows`
- `refactor(ui): extract settings panel into separate component`
- `test(engine): add unit tests for file size calculation`

Breaking changes must include `!` after the type/scope (e.g., `feat(api)!: redesign plugin interface`).

## Efficient Repository Exploration

- Preserve correctness: use focused searches to locate evidence, then read enough surrounding code to understand behavior.
- List candidates with `rg --files` or `fd`; avoid recursive `ls` and unrestricted directory dumps.
- Search with `rg -n -C 2` plus `-g` filters. Read targeted ranges with `sed -n 'START,ENDp'` instead of printing whole large files.
- Use `ast-grep` for syntax-aware searches and refactors where its language parser applies. Review every rewrite with `git diff`.
- Use `tokei --compact`, `jq`, and `yq` for concise repository, JSON, and YAML summaries.
- Start change review with `git diff --stat` or `git status --short`, then inspect only relevant paths.
- Do not scan `node_modules`, generated assets, lockfiles, or build output unless the task specifically requires them.
