# Agents

Instructions for all AI sub-agents (Claude Code agents, worktree agents, etc.) working on this codebase.

## Commit Conventions

Always use [Conventional Commits](https://www.conventionalcommits.org/). Format:

```
<type>(<scope>): <short summary>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.

Breaking changes must include `!` after the type/scope.

## Before Committing

- Run `npm run check` — typecheck, lint, format check, rule validation, tests. This is exactly what CI runs.
- If only formatting fails, `npm run format` fixes it. `npm run lint:fix` handles auto-fixable lint issues.

## Code Style

- Prettier and ESLint are the source of truth (`.prettierrc`, `eslint.config.mjs`). Don't hand-format.
- Follow existing patterns in the codebase.
- Keep PRs focused — one logical change per branch.
- PRs are squash-merged; the PR title must be a Conventional Commit since it becomes the commit message.

## Efficient Repository Exploration

- Preserve correctness: use focused searches to locate evidence, then read enough surrounding code to understand behavior.
- List candidates with `rg --files` or `fd`; avoid recursive `ls` and unrestricted directory dumps.
- Search with `rg -n -C 2` plus `-g` filters. Read targeted ranges with `sed -n 'START,ENDp'` instead of printing whole large files.
- Use `ast-grep` for syntax-aware searches and refactors where its language parser applies. Review every rewrite with `git diff`.
- Use `tokei --compact`, `jq`, and `yq` for concise repository, JSON, and YAML summaries.
- Start change review with `git diff --stat` or `git status --short`, then inspect only relevant paths.
- Do not scan `node_modules`, generated assets, lockfiles, or build output unless the task specifically requires them.
