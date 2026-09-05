# Native cleanup operations

Kudu offers four optional operations alongside ordinary file cleanup:

- **uv Unused Packages:** discovers the configured location with `uv cache dir`, then runs `uv cache prune`.
- **pnpm Unused Packages:** discovers the configured store with `pnpm store path`, then runs `pnpm store prune`. This replaces raw store deletion on Windows, macOS, and Linux.
- **Windows Component Cleanup:** runs DISM `/Online /Cleanup-Image /StartComponentCleanup /NoRestart`, without `/ResetBase`. Requires elevation. Older component versions are removed immediately, rather than waiting for Windows' normal grace period.
- **Delivery Optimization:** uses `Delete-DeliveryOptimizationCache -Force`, without `-IncludePinnedFiles`. Requires elevation and the Windows cmdlet. This replaces the two direct cache-directory rules.

The Windows Bun rule also now targets `${HOME}/.bun/install/cache`, its documented default. Custom Bun cache locations are not discovered by this rule.

## Selection and reporting

Native operations are unselected by default. Select their row explicitly in the desktop cleaner. CLI users can add `--include-maintenance` to a scan with `--clean`; ordinary `--all --clean` does not opt in. Cloud bulk scans omit native operations, and cloud cleanup cannot execute them.

Native operations display **Savings vary**. They contribute zero bytes to totals because the tools do not expose a consistent, trustworthy reclaimable-byte estimate. A successfully completed operation counts as one cleaned item, just as a directory does. Kudu does not claim a per-file native deletion log or secure overwrite for these tool-managed operations.

Scans only check availability and discover paths; they never prune. Missing tools do not fall back to raw directory deletion. Before package pruning Kudu checks that the configured cache location has not changed. Arbitrary Kudu exclusions cannot be passed to these tools, so native operations are unavailable while exclusions are configured, and exclusions are checked again at execution. Commands run asynchronously with hidden windows and bounded timeouts; duplicate executions of the same operation are rejected.

Only fixed action identifiers are accepted in rule JSON. Rules cannot supply commands or arguments. Package commands run from the user home directory rather than the current project.

## References

- [uv cache safety and pruning](https://docs.astral.sh/uv/concepts/cache/)
- [pnpm store pruning](https://pnpm.io/cli/store)
- [Bun global cache](https://bun.sh/docs/pm/global-cache)
- [Windows component cleanup](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/clean-up-the-winsxs-folder?view=windows-11)
- [Delivery Optimization cleanup](https://learn.microsoft.com/en-us/powershell/module/deliveryoptimization/delete-deliveryoptimizationcache?view=windowsserver2025-ps)
