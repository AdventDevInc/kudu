# Security alert triage

Reviewed on 2026-10-18. GitHub alert status is evaluated on the default branch;
changes on a feature branch do not close alerts until merged and analyzed.

## Code scanning

- [Alert 12](https://github.com/AdventDevInc/kudu/security/code-scanning/12):
  the macOS privacy check escaped only periods before interpolating a launchd
  label into a regular expression. Parse override entries with a static regex
  and compare labels literally instead. Regression tests cover exact labels,
  neighboring entries, older boolean states, and the port-probe fallback.
- [Alert 13](https://github.com/AdventDevInc/kudu/security/code-scanning/13):
  CodeQL interpreted a negative test assertion as an HTML filtering regex.
  Use a literal substring assertion for the injected tag, keeping the positive
  XML-escaping assertion and the separate private-metadata checks.

## Dependency alert

[Alert 102](https://github.com/AdventDevInc/kudu/security/dependabot/102) tracks
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
`sprintf-js` has no patched release. The development-only dependency chain was
`electron-builder` → `app-builder-lib` → `@electron/get` → `global-agent` →
`roarr` → `sprintf-js`.

The override for `@electron/get@3.1.0` selects `global-agent@4.1.3`, which removed
`roarr` and `sprintf-js`. This preserves the downloader's CommonJS `bootstrap()`
interface. `scripts/electron-download-proxy.test.ts` exercises the actual
downloader through a local HTTP proxy in an isolated process. Revisit the
override when Electron Builder updates its downloader dependency.

The full npm audit still reports
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) in
`braces`, through `patch-package` → `find-yarn-workspace-root` → `micromatch`.
There is no patched `braces` release at this review date. npm counts this as
four high findings across the affected dependency chain. This tool reads local
workspace patterns during development; it is not a production dependency.
The production-only audit is clean. Do not use `npm audit fix --force` to
downgrade the build tools merely to suppress the report.

## Accepted historical reports

All four accepted reports are already published with affected versions
`< 1.48.0` and patched version `1.48.0`:

- [Cloud command resource exhaustion](https://github.com/AdventDevInc/kudu/security/advisories/GHSA-3wrv-rv55-rj28):
  concurrency limits, per-command spacing, and timeout slot retention are in
  `src/main/services/cloud-agent.ts`, with regression coverage in
  `cloud-agent.flood.test.ts`.
- [File shredder path substitution](https://github.com/AdventDevInc/kudu/security/advisories/GHSA-rwrp-2jqw-f349):
  the shredder records file identity during collection and checks the opened
  handle before overwriting. See `src/main/ipc/file-shredder.ipc.ts` and its tests.
- [Startup task XML substitution](https://github.com/AdventDevInc/kudu/security/advisories/GHSA-r8xh-jffv-g97f):
  task creation uses a randomized temporary path, verifies the registered action
  and arguments, and deletes an unverified task. See `src/main/index.ts` and
  `src/main/startup-task-verify.test.ts`.
- [Remote malware deletion without a detection binding](https://github.com/AdventDevInc/kudu/security/advisories/GHSA-67rx-pc62-j7j8):
  removal requires a recent detection with matching content; remote quarantine
  and deletion require cleanup permission. See `src/main/ipc/malware-scanner.ipc.ts`
  and `src/main/services/cloud-agent.ts`.

These published advisories are the historical record of affected releases and
their fixes. Publication is not an unresolved-alert state. Preserve them and
their reporter credits; correcting factual errors is different from withdrawing
a valid advisory.
