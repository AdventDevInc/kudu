# Contributing Cleaner Rules

Kudu's cleaning targets are defined as JSON files in this directory. Adding support for a new app, game launcher, or cache location is as simple as editing a JSON file — no TypeScript or Electron knowledge required.

Browse the [full cleaner directory](https://usekudu.com/cleaners) to see what's already covered and what's missing.

## Directory Layout

```
rules/
  schema/rules.schema.json    # JSON Schema (editor autocomplete + validation)
  win32/                       # Windows rules
  darwin/                      # macOS rules
  linux/                       # Linux rules
```

Each platform has 8 files:

| File | What it defines |
|------|----------------|
| `apps.json` | Application caches (Discord, VS Code, Spotify, etc.) |
| `browsers.json` | Browser cache paths (Chrome, Firefox, Safari, etc.) |
| `gaming.json` | Game launcher caches (Steam, Epic, EA, etc.) |
| `gpu-cache.json` | GPU shader caches (NVIDIA, AMD, Intel, Mesa) |
| `system.json` | System temp files, logs, crash dumps |
| `databases.json` | SQLite databases to vacuum-optimize |
| `steam.json` | Steam library paths and redistributable patterns |
| `misc.json` | Protected event logs and trash path |

## Quick Start: Use the CLI Generator

The fastest way to add a new rule — no manual JSON editing needed:

```bash
npm run new-rule
```

This interactive tool will ask for the app name, platforms, and cache paths, then write the JSON entries for you. It auto-detects Chromium/Electron apps and generates the standard cache subdirectories.

### Other Helpful Tools

```bash
npm run find-cache       # Discover uncovered cache directories on your machine
npm run preview-rule     # Preview what a rule would clean (dry run)
npm run parity-check     # See cross-platform coverage gaps
npm run catalog          # Regenerate the rules catalog page
```

## Adding a New App Cleaner (Manual)

If you prefer to edit the JSON files directly, here's how:

### 1. Find the cache paths

Find where the app stores its cache on each platform. Common locations:

| Platform | Typical locations |
|----------|------------------|
| Windows | `%LOCALAPPDATA%\AppName\`, `%APPDATA%\AppName\` |
| macOS | `~/Library/Caches/com.app.name`, `~/Library/Application Support/AppName/` |
| Linux | `~/.cache/appname`, `~/.config/appname/` |

**Only target cache, temp, and log directories.** Never include user data, settings, login tokens, or databases that store user content.

### 2. Add the entry

Add your app to `apps.json` for each platform where it exists. Example for a hypothetical "Acme Editor":

```json
{
  "id": "acme-editor",
  "name": "Acme Editor",
  "paths": [
    "${APPDATA}/AcmeEditor/Cache/Cache_Data",
    "${APPDATA}/AcmeEditor/logs"
  ]
}
```

### 3. Template Variables

Paths use template variables instead of hardcoded locations. The loader resolves these at runtime.

**Windows (`win32/`):**
| Variable | Resolves to |
|----------|-------------|
| `${HOME}` | `C:\Users\<username>` |
| `${LOCALAPPDATA}` | `C:\Users\<username>\AppData\Local` |
| `${APPDATA}` | `C:\Users\<username>\AppData\Roaming` |
| `${WINDIR}` | `C:\Windows` |
| `${PROGRAMDATA}` | `C:\ProgramData` |
| `${PROGRAMFILES}` | `C:\Program Files` |
| `${PROGRAMFILES_X86}` | `C:\Program Files (x86)` |
| `${TMPDIR}` | System temp directory |

**macOS (`darwin/`):**
| Variable | Resolves to |
|----------|-------------|
| `${HOME}` | `/Users/<username>` |
| `${LIBRARY}` | `~/Library` |
| `${CACHES}` | `~/Library/Caches` |
| `${APP_SUPPORT}` | `~/Library/Application Support` |
| `${TMPDIR}` | System temp directory |

**Linux (`linux/`):**
| Variable | Resolves to |
|----------|-------------|
| `${HOME}` | `/home/<username>` |
| `${CONFIG}` | `~/.config` |
| `${CACHE}` | `~/.cache` |
| `${LOCAL_SHARE}` | `~/.local/share` |
| `${TMPDIR}` | System temp directory |

### 4. JSON Format Rules

- Use **forward slashes** (`/`) in all paths — the loader converts to backslashes on Windows automatically.
- App IDs must be **lowercase with hyphens** (e.g. `my-app`, not `MyApp`).
- Each app needs at least one path.
- Add `"minAgeDays"` when a cache or log needs a longer retention window. Directory contents are checked recursively before a whole directory is offered.
- Add `"childSubdir"` if caches are in versioned subdirectories (e.g. JetBrains stores caches in `JetBrains/<version>/caches`).
- Add `"recursiveMatch"` only when cache paths have dynamic nesting. It returns exact target directory names beneath a required anchor and never follows directory links. For broad bases, provide `"anchorPaths"` so anchor discovery follows bounded relative patterns instead of recursively walking unrelated folders.
- Add `"fileMatch"` only for a small allowlist of exact direct filenames. It can inspect immediate child directories by suffix, but never traverses their nested state.

### 5. Editor Autocomplete

Every JSON file includes a `$schema` reference. If your editor supports JSON Schema (VS Code, IntelliJ, etc.), you'll get autocomplete and inline validation automatically.

### 6. Validate Your Changes

```bash
npm run validate:rules
```

This checks all rule files against the schema, verifies template variables are valid for each platform, and catches duplicate IDs. This also runs automatically in CI on every PR.

### 7. Run Tests

```bash
npm test
```

The test suite includes schema validation tests that verify every rule file.

## Field Reference

### App/Gaming/GPU Cache Entry (`apps.json`, `gaming.json`, `gpu-cache.json`)

```json
{
  "id": "app-name",           // Required. Lowercase, hyphens ok.
  "name": "Display Name",     // Required. Shown in the UI.
  "paths": ["${VAR}/path"],   // Required. At least one path.
  "group": "AI Tools",        // Optional. Groups related cleaner rules in the UI.
  "minAgeDays": 7,            // Optional. Preserve newer entries and inspect nested contents.
  "childSubdir": "caches",    // Optional. Scan path/*/childSubdir.
  "recursiveMatch": {          // Optional alternative to childSubdir.
    "anchor": "EBWebView",    // Targets must be beneath this exact directory.
    "anchorPaths": ["*/EBWebView", "Packages/*/LocalState/EBWebView"],
                                // Optional bounded anchor discovery; * matches one directory.
    "targets": ["Cache", "Code Cache", "GPUCache"],
    "excludedAncestors": ["Local Storage", "IndexedDB"],
    "maxDepth": 12             // Optional; defaults to 12, maximum 32.
  },
  "fileMatch": {               // Optional alternative for exact direct files.
    "names": ["installer.exe", "current.blockmap"],
    "childDirSuffix": "-updater", // Optional; inspect matching immediate children.
    "minAgeDays": 14,          // Required for file matches.
    "skipIfChildExists": ["pending"]
  },
  "description": "Why safe"   // Optional. Explain what's cleaned.
}
```

`childSubdir`, `recursiveMatch`, and `fileMatch` are mutually exclusive. Recursive targets and file-match names must be single names, not paths or globs; this prevents a broad base path from becoming directly cleanable. Each `anchorPaths` value is relative to a configured base, may use `*` for exactly one directory segment, and must end with the configured anchor name. A file match considers direct files only, and `skipIfChildExists` rejects the whole candidate directory when protected state such as `pending` is present.

### System Clean Target (`system.json`)

```json
{
  "path": "${VAR}/path",        // Required.
  "subcategory": "Label",       // Required. Shown in the UI.
  "needsAdmin": true,           // Optional. Requires elevation.
  "childSubdir": "cache",       // Optional. Scan path/*/childSubdir.
  "deepRecencyCheck": true,      // Optional. Protect recent descendants through cleanup.
  "description": "Details"      // Optional.
}
```

### Database Target (`databases.json`)

```json
{
  "label": "App Name",                  // Required. Display label.
  "basePath": "${VAR}/path",             // Required. Base directory.
  "dbFiles": ["History", "Cookies"],     // Required. DB filenames or "$shared" ref.
  "multiProfile": true,                  // Optional. Scan profile subdirs.
  "profilePattern": ["*.default*"]       // Optional. Glob for profiles.
}
```

Use `"dbFiles": "$chromium"` to reference the `sharedDbFileSets` instead of repeating the same list.

## Safety Guidelines

- **Only clean cache, temp, and log data.** Never target user documents, settings, passwords, bookmarks, or session tokens.
- **Mark system paths as `needsAdmin: true`** if they require elevated privileges.
- **Use retention windows for active apps and services.** Prefer `minAgeDays` for logs, updater artifacts, and caches whose containing directories may stay active.
- **Use exact file allowlists for updater artifacts.** Never target an updater directory wholesale or descend into a `pending` directory.
- **Test on a real system** before submitting — verify the paths actually exist and contain only disposable data.
- **When in doubt, don't include it.** It's better to miss a cache directory than to delete something important.
