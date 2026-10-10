# Windows app cache coverage

This records the scope and evidence for T3 Code v2, Spark Desktop, Pinokio,
Granola, and WSL Cleaner. Paths were verified by read-only directory metadata
inspection on Windows on 2026-10-10. No live app data was read or removed.

## Scope

| Application | Profile directory | Ordinary cleanup | Optional performance reset |
| --- | --- | --- | --- |
| T3 Code | `%APPDATA%/t3code`, `%APPDATA%/t3code-v2` | `Cache/Cache_Data`, `Shared Dictionary/cache`, anchored preview-partition HTTP caches | Compiled-code and shader caches, including preview partitions |
| Spark Desktop | `%LOCALAPPDATA%/Spark Desktop` | None | Compiled-code and shader caches only |
| Pinokio | `%APPDATA%/Pinokio` | `Cache/Cache_Data` | Compiled-code and shader caches |
| Granola | `%APPDATA%/Granola` | `Cache/Cache_Data` | Compiled-code and shader caches |
| WSL Cleaner | `%APPDATA%/wsl-cleaner` | `Cache/Cache_Data` | Compiled-code and shader caches |

Performance reset leaves are exactly `Code Cache`, `GPUCache`,
`DawnGraphiteCache`, and `DawnWebGPUCache`. The existing T3 Code partition
matcher also recognizes `DawnCache`. No profile root or wildcard app discovery
is directly cleanable. T3 Code's existing partition exclusions prevent matching
cache-shaped directories inside persistent browser storage.

Every rule has `minAgeDays: 1`, following the current Windows Electron cache
rules. The scanner checks descendant recency; a stale directory timestamp does
not authorize removal of a recent file. This is a recency safeguard, not a
guarantee that an app is closed. Cleanup rechecks recency and skips files it
cannot remove. Quit the relevant app before intentionally resetting caches.

Compiled-code and shader caches use `cacheReset: true`: unselected by default,
shown in the optional reset group with the slower-next-launch notice, excluded
from cloud cleanup, and gated by `--include-cache-resets` in the CLI.

## Evidence and boundaries

- [Electron's app path documentation](https://www.electronjs.org/docs/latest/api/app#appgetpathname)
  distinguishes Chromium caches from user data and describes the default
  Windows profile location. Cache classification here combines that upstream
  documentation with observed directory layout; it is not a claim that every
  vendor recommends external cache deletion.
- [T3 Code's Electron integration](https://github.com/pingdotgg/t3code/blob/main/apps/desktop/src/electron/ElectronApp.ts)
  uses Electron's app paths. Both observed profile names are explicitly listed;
  v2 preview profiles were observed under `Partitions/t3code-preview-*`.
  Workspaces, `.t3` runtime data, credentials, and browser storage are excluded.
- [Pinokio's package definition](https://github.com/pinokiocomputer/pinokio/blob/main/package.json)
  identifies its Electron application as `Pinokio`. These rules never inspect
  the Pinokio home, installed applications, environments, models, or downloads.
- [WSL Cleaner's main process](https://github.com/dbfx/wsl-cleaner/blob/main/main.js)
  initializes preferences and history stores under `userData`. Only the exact
  Chromium cache leaves are included; no history, settings, distributions, or
  virtual disks are targeted, and no WSL command is invoked.
- [Spark's cache documentation](https://sparkmailapp.com/help/troubleshooting/how-to-clear-cache-in-spark)
  explains its offline email and attachment cache without identifying its disk
  boundaries. Therefore **Spark's HTTP cache is deliberately excluded**.
  `core-data`, `core-tmp`, `storage`, `transcription-data`, and all session and
  database stores are also excluded. Only compiled-code/shader resets are added.
- Granola's observed profile contains persistent databases, encrypted account
  data, and a `cache-v6.json.enc` file alongside Chromium cache directories.
  No `cache*` wildcard is used: these files, transcripts, account state,
  local storage, and IndexedDB are outside every rule. The rule targets only
  Chromium's exact cache directories, not Granola's application-level cache.

The regression fixtures load the actual rules and exercise the shared scanner:
settled versus recent entries, old parent timestamps, protected sibling data,
T3 v1/v2 partition boundaries, Spark offline-store exclusions, and optional
reset selection. Live `preview-rule` runs inspect metadata only; their totals
are estimates, not promised reclaimable bytes or a cleanup test.
