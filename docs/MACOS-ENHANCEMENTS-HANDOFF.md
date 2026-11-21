# macOS tools and scheduled application opening

Maintainer handoff for [AdventDevInc/kudu](https://github.com/AdventDevInc/kudu).

Prepared on 12 November 2026. The local implementation was developed against a Kudu source snapshot with package version 3.13.0. The contribution branch is based on upstream commit `127f236ecd445419e60753ca7983ebaf374d6e1c`.

## Contribution summary

This contribution adds two features.

1. Scheduled application opening with selectable weekdays and daily or weekly frequency.
2. Seven macOS tools in Settings for Spotlight, application associations, PATH correction, battery diagnostics, energy profiles, animations and an HTML audit.

The implementation uses Kudu's Electron, React and TypeScript architecture. A standalone JavaScript for Automation runner lets macOS execute application schedules while Kudu is closed.

## Repository preparation

The contribution is organized on branch `codex/macos-tools-and-app-schedules`
in a dedicated checkout of the official Kudu repository. All paths in the manifest
are relative to that repository root.

For transfer into another checkout, use the file manifest below and merge its
integration points into the corresponding upstream files. Keep the review focused
on those files and this handoff.

## Implemented behavior

### Scheduled application opening

The Startup page has a schedule panel with seven weekday checkboxes and two frequencies.

| Setting | Behavior |
| --- | --- |
| Daily | One opening request on each selected local calendar day |
| Weekly | One opening request per Monday-based local calendar week, on the first eligible selected day |
| Default | Saturday and Sunday, once per week |
| Checks | At agent load or login, then every five minutes during the user session |
| Missed days | The next check evaluates the current day |
| Existing schedules | A configuration without a policy uses the Saturday/Sunday weekly default |
| Editing | Each existing application has its own day controls and a Save days button |
| Removal | Unload the managed user agent and remove its stored schedule |

The schedule is stored in Kudu's user-data directory under `weekend-app-launches/<id>/`. Its configuration contains the application path and policy. Its receipt contains the last opening time, period key and last error.

The ID is derived from the application's canonical path. Agent labels use `com.kudu.weekend-app.<id>`. Each agent is installed under the current user's `Library/LaunchAgents` directory and loaded into `gui/<uid>` using `launchctl bootstrap`.

The runner invokes `/usr/bin/open -a` with an argument array. It writes a receipt after the opening request succeeds. Saturday and Sunday share a week key. Editing selected days preserves the receipt and the current period's successful opening.

The panel explains that the application's existing Open at Login setting must be disabled for the new schedule to control its opening.

### Seven Settings tabs

The entry point is **Settings → Mac tools**.

| Tab | Implemented behavior | Main implementation |
| --- | --- | --- |
| Spotlight | List the startup disk and mounted local volumes, read indexing status, enable indexing and request a rebuild of the selected volume | `mac-tools.ts` |
| App associations | Rebuild LaunchServices registrations across user, local and system domains | `mac-tools.ts` |
| PATH | Analyze a selected shell configuration, preview original and proposed assignments, remove missing or duplicate entries, reorder retained entries, save a backup and restore the last correction | `mac-path.ts` |
| Battery | Display charge, cycle count, estimated capacity health, maximum and design capacity, estimated time remaining, charging state and temperature when available | `mac-tools.ts` |
| Energy | Read per-source settings, apply Economy or Balanced and restore the original snapshot | `mac-tools.ts` |
| Animations | Read supported preference keys, apply Faster or Reduced and restore the original snapshot | `mac-tools.ts` |
| Global audit | Collect nine sections, preview storage utilization and collection status, export a standalone HTML file through a save dialog | `mac-audit.ts` |

Energy profiles update only the supported `sleep`, `displaysleep` and `lowpowermode` keys reported for each power source.

| Profile | Display sleep | System sleep | Low Power Mode |
| --- | --- | --- | --- |
| Economy | 5 minutes | 15 minutes | Enabled on battery when supported, disabled on other supported sources |
| Balanced | 10 minutes | 30 minutes | Disabled when supported |

Animation profiles cover the Dock reveal duration and delay, minimization effect, launch animation, window animation preference and resize duration. Applying or restoring a profile restarts Dock. Window preferences affect newly opened windows.

The audit includes system information, storage, applications, startup items, network interfaces, firewall, FileVault, XProtect and battery data. It reuses Kudu's existing collectors. Each section records whether collection completed. Storage charts use inline HTML and CSS. Dynamic data is escaped and the exported document has a restrictive Content Security Policy.

## iCloud management and local device backups

**Clean up → iCloud & device backups** adds three tabs.

| Tab | Behavior |
| --- | --- |
| iCloud services | A searchable catalog covering the requested Apple and third-party apps, with native application and iCloud Settings entry points |
| iCloud backups | Opens Apple Account storage management and explains device backup removal and its effect on automatic backups |
| Local backups | Scans MobileSync backup metadata and allocated size, then moves explicitly selected eligible backups to Trash |

Mail/iCloud Mail share one service entry. Cartes/Maps/Plans share one entry.
The catalog has 32 service IDs covering the supplied names. Application presence
is checked in standard application directories. iCloud activation and cloud
storage usage are verified in Apple or application settings.

Apple's account and application interfaces handle the cloud data deletion and
final confirmation. CloudKit access is scoped by app entitlements. The UI states
that synced deletion can affect all devices and that recovery depends on the
service/account. It also explains permanent-loss risks after recovery windows or
Trash emptying. Native cloud management is the integration boundary for this
contribution.

Local backup removal uses opaque scan IDs and backup IDs, with a ten-minute
scan lifetime. Eligible backups have regular Info, Manifest and Status plist
files, a finished SnapshotState, a stable tree and files older than one minute.
The service validates identities again, claims the directory privately and
rechecks it before calling the native Trash API. A failed operation preserves
the claim and reports its path. A private restore destination is retained for
successfully trashed backups. User instructions explain moving restored backup
identifier folders back into MobileSync/Backup.

### Additional contribution files

| File | Change |
| --- | --- |
| `src/shared/icloud-cleanup.ts` | Service catalog and backup scan/removal types |
| `src/main/services/device-backups.ts` | Scoped backup inventory, identity validation, directory claim and native Trash delegation |
| `src/main/services/device-backups.test.ts` | Backup selection, stale scans, typed confirmation, incomplete/recent backups, changed roots and retained failures |
| `src/main/ipc/icloud-cleanup.ipc.ts` | macOS-only management destinations and local backup operations |
| `src/main/ipc/icloud-cleanup.ipc.test.ts` | Destination allowlist, catalog and backup IPC tests |
| `src/renderer/src/pages/ICloudCleanupPage.tsx` | Service catalog, cloud backup guide, local backup selection and confirmation |
| `src/renderer/src/components/shared/ConfirmDialog.tsx` | Optional disabled confirmation state, used until the required acknowledgments are complete |
| `src/renderer/src/components/layout/Sidebar.tsx` | macOS-only navigation entry under Clean up |
| `src/renderer/src/App.tsx` | Page route and translated route title |

Also merge the iCloud IPC channels, preload methods, registration call and
English/French Settings translations in the already listed integration files.

References for these flows are [Apple's storage management instructions](https://support.apple.com/108922),
[iCloud file recovery](https://support.apple.com/guide/icloud/mmae56ea1ca5/icloud)
and [CloudKit container access](https://developer.apple.com/documentation/cloudkit/ckcontainer).

## File manifest

All paths below are relative to the Kudu repository root.

### New files

| File | Purpose |
| --- | --- |
| `src/shared/app-launch.ts` | Schedule types, input validation, default policy and local date/week keys |
| `src/shared/app-launch.test.ts` | Day validation and calendar boundary tests |
| `src/shared/mac-tools.ts` | Mac tool actions, reports, volumes, PATH plans and audit summary types |
| `src/main/services/weekend-app-launches.ts` | Schedule persistence, agent installation, listing, editing and removal |
| `src/main/services/weekend-app-launches.test.ts` | Lifecycle, duplicate prevention, failed registration rollback and legacy policy tests |
| `src/main/services/weekend-app-runner.ts` | Standalone JXA runner source |
| `src/main/services/weekend-app-runner.test.ts` | Opening frequency, retries, allowed days and resume behavior |
| `src/main/ipc/weekend-app-launches.ipc.ts` | Schedule IPC handlers and native application chooser |
| `src/renderer/src/components/shared/WeekendAppLaunches.tsx` | Application schedule panel and weekday/frequency controls |
| `src/main/services/mac-tools.ts` | Diagnostics, maintenance actions and restorable energy/animation profiles |
| `src/main/services/mac-tools.test.ts` | Profile application, partial failure, restoration and conflict tests |
| `src/main/services/mac-path.ts` | Conservative PATH analysis, preview validation, correction and restoration |
| `src/main/services/mac-path.test.ts` | Parsing, stale plans, symlinks, inherited PATH and restoration tests |
| `src/main/services/mac-audit.ts` | Audit collection, HTML rendering and native export |
| `src/main/services/mac-audit.test.ts` | Escaping, chart bounds and partial report tests |
| `src/main/ipc/mac-tools.ipc.ts` | Diagnostic, maintenance, PATH and audit IPC handlers |
| `src/renderer/src/components/shared/MacToolsPanel.tsx` | Seven Settings tabs, results, previews and confirmation dialogs |

### Existing files to merge

| File | Integration point |
| --- | --- |
| `src/shared/channels.ts` | Add the `WEEKEND_APPS_*`, `MAC_TOOLS_*`, `MAC_PATH_*` and `MAC_AUDIT_*` channels |
| `src/preload/index.ts` | Expose the typed schedule and Mac tools methods listed below |
| `src/main/ipc/index.ts` | Import and call `registerWeekendAppLaunchesIpc()` and `registerMacToolsIpc()` |
| `src/main/platform/darwin/privacy.ts` | Export the existing typed defaults helpers and `elevatedBatch`, add its optional prompt argument and recognize Golden Gate's missing-key message |
| `src/main/platform/darwin/privacy.test.ts` | Add the Golden Gate missing-key regression test while retaining authorization failure coverage |
| `src/renderer/src/pages/StartupPage.tsx` | Render `WeekendAppLaunches` below the page header |
| `src/renderer/src/pages/SettingsPage.tsx` | Add the Mac tools navigation entry and render `MacToolsPanel` for `darwin` |
| `src/renderer/src/locales/en/startup.json` | Schedule descriptions, day names, frequencies and action labels |
| `src/renderer/src/locales/fr/startup.json` | French schedule translations |
| `src/renderer/src/locales/en/settings.json` | The `mac` translation group |
| `src/renderer/src/locales/fr/settings.json` | The French `mac` translation group |
| `README.md` | Document application schedules and the seven Mac tools |

Preserve the existing startup translation keys when merging. Some internal names retain `weekend` for compatibility with the earlier schedule implementation.

### Preload API

| Method | Input | Result |
| --- | --- | --- |
| `weekendAppsList` | None | Stored schedules and current loaded status |
| `weekendAppsAdd` | `AppLaunchPolicy` | Native chooser and schedule creation result |
| `weekendAppsUpdate` | Schedule ID and policy | Save allowed days and frequency |
| `weekendAppsRemove` | Schedule ID | Remove the schedule |
| `macToolsRead` | Diagnostic name | `MacToolReport` |
| `macToolsApply` | `MacToolAction` | Execute the validated maintenance/profile action |
| `macPathRead` | Supported shell filename | `MacPathPlan` |
| `macPathApply` | Filename, content hash and selected entry order per line | Updated plan |
| `macPathRestore` | Supported shell filename | Restored plan |
| `macAuditCreate` | Language | Audit summary and snapshot ID |
| `macAuditExport` | Snapshot ID | Chosen output path or cancellation |

## State and recovery details

Schedule configuration, runner source and receipt live together in the per-application schedule directory. Configuration updates replace files atomically. Main-process schedule edits are serialized.

Energy and animation snapshots live under `<userData>/mac-tools/`. They preserve the settings from before the first profile application. Restoration validates the current values against the recorded original and applied values to detect later edits.

PATH backups live under `<userData>/mac-tools/path/`. A correction requires a matching content hash and rechecks the file before replacement. The preview identifies the order of the existing entries. The inherited `$PATH` token is retained when present.

The PATH editor supports `.zshrc`, `.zprofile`, `.bashrc`, `.bash_profile` and `.profile`. Eligible files are regular user-owned files up to 1 MB. It handles supported literal assignments, including HOME references. Configurations containing heredocs or multiline strings require manual review. Duplicate detection currently operates within each editable assignment.

## Manual integration sequence

1. Read the target repository's `AGENTS.md` and record the base commit.
2. Add the shared types and service files from the manifest.
3. Merge the small defaults/elevation helper changes into the existing Darwin adapter.
4. Add the IPC handlers, channel constants and preload methods together.
5. Add the schedule component to Startup and the tabbed tool component to Settings.
6. Merge English and French translation entries and the README additions.
7. Review the final diff against the manifest.
8. Run the repository checks, production build and native acceptance cases.

Two pull requests would make review easier. The first can contain application scheduling. The second can contain the seven Mac tools and the defaults compatibility fix. Use the repository's Conventional Commit format.

Suggested titles are `feat(macos): schedule application opening by weekday` and `feat(macos): add maintenance tools to settings`.

## Handoff prompt for an AI coding assistant

```text
Integrate the macOS additions described in docs/MACOS-ENHANCEMENTS-HANDOFF.md
into this Kudu branch.

Read AGENTS.md and inspect the current implementations before editing. Use the
file manifest to map the supplied implementation to the current upstream code.
Merge channels, preload APIs, registration calls, translations and page entries
into their existing files.

Preserve legacy schedules without a policy as weekly Saturday/Sunday schedules.
Keep the daily and weekly local-calendar semantics. Preserve receipt handling,
input validation, serialized edits, backups and restoration conflict checks.

Reuse Kudu's existing collectors, confirmation dialogs and authorization helpers.
Validate each exposed action in the main process. Exercise mutations with fixture
files and mocked system commands. Use native read-only diagnostics for device QA.

Run the standard project checks and production build. Review the diff, report
remaining platform limitations and distinguish implemented work from follow-up
proposals. Prepare focused Conventional Commit changes for maintainer review.
```

## Recorded verification

The implementation session completed the following checks.

| Check | Recorded result |
| --- | --- |
| TypeScript checks | Passed |
| Production build | Passed |
| Complete test suite | 3,870 passed, 3 skipped, across 225 passing test files |
| Lint | Completed without errors, with existing repository warnings |
| Cleaner rule validation | All rule files valid |
| Native schedule lifecycle | Temporary agent registration and removal verified |
| Native UI | Weekday controls, seven Settings tabs and the three iCloud tabs verified in French |
| Read-only device checks | Spotlight status, battery data, energy settings, PATH preview and defaults reading verified |
| HTML export | Nine-section report generated and saved, with charts and escaped content |

Local device backup analysis was checked in the native UI with no recognized backups present. Backup removal was exercised with generated fixture backups. The control tool denied access to System Settings, so the destination screen requires manual verification.

Maintenance/profile mutations were exercised through simulated system commands. The device checks above describe the native operations performed during QA.

The repository's `validate:rules` command invokes `npx tsx`. During this session, `tsx` was unavailable as a local dependency, so the rule validator was also executed with the installed TypeScript compiler. The initial recorded results combined these separately completed checks. In the dedicated contribution checkout, `npm run check` and `npm run build` subsequently both completed successfully.

Run the current checkout's normal verification before submission.

```sh
npm ci
npm run check
npm run build
```

## Acceptance cases for the maintainer

- Create a Monday/Wednesday daily schedule and verify one request per selected day.
- Create a Saturday/Sunday weekly schedule and verify a shared weekly receipt.
- Verify the week boundary across New Year and a daylight-saving transition.
- Edit an existing legacy schedule and confirm its receipt is preserved.
- Remove a schedule and verify its user agent and stored files are removed.
- Verify the current local day after sleep or a missed scheduled period.
- Read Spotlight status and verify the chosen mounted volume is the action target.
- Verify the associations confirmation and completion result.
- Correct a fixture PATH, restore it and verify unrelated content and line endings.
- Change the shell file after analysis and verify the stale preview is rejected.
- Exercise partially applied energy/animation profiles and restoration.
- Change a managed setting outside Kudu and verify restoration conflict handling.
- Check battery-present and battery-absent machines, including missing sensors.
- Export an audit with a failed collector and verify the partial report.
- Verify macOS tools visibility and request rejection on the other supported platforms.

## Proposed follow-up work

These proposals are separate from the implemented features.

| Priority | Proposal | Benefit |
| --- | --- | --- |
| 1 | Next-opening preview, selectable time and a clear last-attempt/result display | Makes schedules easier to understand and diagnose |
| 1 | Move macOS profile and PATH snapshots into Kudu's recovery workflow | Gives users one place to inspect and restore changes |
| 1 | Capability checks and native tests across supported macOS versions and hardware | Makes preference keys, energy controls and sensor availability explicit |
| 1 | Add a local development dependency for the rule validator's TypeScript runner | Makes the documented checks reproducible after installation |
| 2 | Manage scheduled agents during application uninstall and moved-app recovery | Keeps scheduled launches maintainable over the app lifecycle |
| 2 | Review and strengthen the opening receipt's crash behavior | Handles interruption between an opening request and receipt persistence |
| 2 | Add structured before/after previews for energy and animation profiles | Makes the exact effect of each profile easier to review |
| 2 | Expand PATH analysis with a tested shell parser and explicit scope handling | Extends support beyond the current literal-assignment subset |
| 3 | Add a more readable audit summary alongside the collected JSON sections | Makes exported reports easier to share with support |
| 3 | Complete translations for the other supported languages | Extends the English and French implementation |

For application opening, a successful `open` command records that LaunchServices accepted the request. The current receipt describes that request. The crash-behavior follow-up should explicitly define the desired retry policy.

## Architecture references

The implementation studied launchr's user-agent lifecycle and schedule representation, together with Outset's login execution tracking. The supplied TypeScript/JXA implementation is original.

- [launchr](https://github.com/scoult/launchr)
- [launchr launchctl wrapper](https://github.com/scoult/launchr/blob/main/src-tauri/src/launchctl.rs)
- [launchr schedule model](https://github.com/scoult/launchr/blob/main/src-tauri/src/plist_model.rs)
- [Outset](https://github.com/macadmins/outset)
- [CR Mac Helper modules](https://github.com/punksm4ck/cr-mac-helper/tree/main/modules)
