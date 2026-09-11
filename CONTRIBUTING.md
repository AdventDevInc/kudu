# Contributing to Kudu

Thanks for your interest in contributing! Kudu is a community-driven project and we welcome all contributions — bug reports, feature requests, documentation improvements, and code.

## Getting Started

1. Fork the repository
2. Clone your fork and create a branch:
   ```bash
   git clone https://github.com/YOUR_USERNAME/kudu.git
   cd kudu
   git checkout -b my-feature
   ```
3. Install dependencies (Node 22 — see `.nvmrc`):
   ```bash
   npm install
   ```
4. Start the dev server:
   ```bash
   npm run dev
   ```

## Project Structure

```
rules/           # Cleaner rule definitions (JSON) — edit these to add new cleaners!
src/
├── main/        # Electron main process
├── preload/     # Preload scripts (bridge between main & renderer)
├── renderer/    # React frontend
└── shared/      # Shared types and utilities
```

## Adding Cleaner Rules

Want to add support for cleaning a new app's cache? You don't need to write any TypeScript — just edit a JSON file in the [`rules/`](rules/) directory. See the **[Rules Contributing Guide](rules/RULES.md)** for full instructions and the **[Rules Catalog](rules/CATALOG.md)** for what's already covered.

**Fastest way** — use the interactive generator:
```bash
npm run new-rule
```

**Manual way:**
1. Add your app to `rules/<platform>/apps.json`
2. Run `npm run validate:rules` to check your changes
3. Run `npm test` to make sure everything passes
4. Submit a PR!

**Helpful tools for contributors:**
```bash
npm run find-cache       # Discover uncovered cache dirs on your machine
npm run preview-rule     # Dry-run a rule to see what it would clean
npm run parity-check     # Find cross-platform coverage gaps
npm run catalog          # Regenerate the rules catalog
```

## Making Changes

- Keep changes focused — one feature or fix per PR. Small PRs get reviewed faster.
- Open an issue first for anything non-trivial so we can agree on the approach before you invest time.
- Write or update tests for behaviour changes (`npm test`).
- Formatting and lint are enforced by CI, so don't hand-format — run the tools:
  ```bash
  npm run format      # Prettier — fixes formatting
  npm run lint:fix    # ESLint — fixes what it can, reports the rest
  npm run typecheck   # tsc across main + renderer
  npm run check       # everything CI runs, in one go
  ```
  Tip: enable "format on save" with the Prettier extension in your editor and you'll never think about it.

## Submitting a Pull Request

1. Run `npm run check` — it mirrors CI (typecheck, lint, format, rule validation, tests).
2. Push your branch and open a PR against `main`.
3. **Give the PR a [Conventional Commits](https://www.conventionalcommits.org/) title.** PRs are squash-merged and the title becomes the commit message, which drives the changelog. Individual commits inside your PR can be anything.
   - `feat(rules): add Spotify cache rule`
   - `fix(scanner): handle missing registry keys on Windows`
   - `docs: clarify install steps`
   - Breaking change: `feat(api)!: redesign plugin interface`

   Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
4. Fill out the PR template — what changed, why, and how to test it.
5. CI runs on Windows, macOS and Linux. All checks must be green before merge.

### Review

A maintainer will review within a few days. We may ask for changes — that's normal and not a judgement on the work. Once approved, a maintainer merges. If a PR goes quiet for 60 days the stale bot will nudge it; just reply to keep it open.

## Reporting Bugs

Use the [bug report template](https://github.com/adventdevinc/kudu/issues/new?template=bug_report.md). Include your OS, Kudu version, and steps to reproduce.

## Suggesting Features

Use the [feature request template](https://github.com/adventdevinc/kudu/issues/new?template=feature_request.md).

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be respectful and constructive — we're all here to build something useful.
