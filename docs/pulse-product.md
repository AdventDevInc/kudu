# Pulse product design

The production renderer now uses the selected Pulse direction: charcoal grey surfaces, warm amber primary actions, restrained mint meters, readable graphs, and contextual tool guidance. Kudu's logo, navigation groups, routes, and native operations remain connected to the existing product.

Synced with origin/main at 78f53fd0 (custom cleaner builder, storage history, Recovery Centre, Cloud diagnostics, and schedule conditions/workflows). The design changes remain in the working tree. A safety stash preserves the full pre-sync design.

The colours now match the original Pulse concept exactly: page #101519, panels #171e23, sidebar #11171b, amber #f2b354, and mint #8cd4b0.

## Page treatments

- Home: compact CPU and memory cards with real sparklines, drive capacity, actionable care checks, recent history, and explicit routes into cleanup, protection, and scheduling.
- Cleaner: category navigation, prominent scan action, selected/recoverable totals above the results, and the existing review and confirmation flow.
- Protection: distinct guidance and decorative tool illustrations for malware, firewall, privacy, vulnerabilities, breach monitoring, and threat monitoring.
- Storage: directory selection workspaces, contextual artwork, existing treemap/results and file selection controls.
- Performance: segmented resource meters, time-based CPU/memory/disk graphs, real transfer rates instead of arbitrary throughput percentages, and the existing process table.
- Game Mode: a quiet profile summary and one clearly labelled activation control; configuration and rollback behavior are unchanged.
- Schedules: upcoming routine dates, always-visible edit/duplicate/delete controls, and keyboard-contained template/editor dialogs with Escape dismissal.
- Settings: direct section navigation, responsive controls, and focus placement when jumping to a section.
- New main features: a two-column custom cleaner builder, diagnostics recording/history workspace, Recovery Centre overview, storage history graph using comparable complete snapshots, and styled scheduling conditions.
- Other tools: shared charcoal surfaces, tailored page descriptions and three-step guidance, clearer primary scan actions, responsive tables, and consistent empty/result states across all 35 routes.

## Review locally

Run `npm run dev:ui` and open http://localhost:5186/ui-preview.html. This loads the real React product with a separate, labelled, browser-only sample bridge. It never connects to Electron or changes the computer. Supported sample scans populate review screens; unsimulated operations intentionally return an error. Use `?theme=light` for light appearance and `?state=empty` for empty account/history fixtures. The preview entry is excluded from the Electron production build.

The exploratory concept studios have been removed. Home now offers Simple mode with three outcome cards and Advanced mode containing the existing Pulse dashboard. The view is saved in Kudu settings; Simple is the default. Both modes follow the selected light or dark appearance.

## Validation

- `npm run check`: passed, 162 test files, 2,977 passed tests, and one upstream skipped test. Existing lint warnings remain.
- `npm run build`: passed for main, preload, and renderer.
- One repeat check encountered timing-sensitive failures in existing cleanup-receipts tests. The focused rerun and final full check passed without changes to those tests or services.
- All 35 routes rendered without an error boundary or horizontal page overflow at 1000 by 760; desktop previews checked at 1440 by 1080.
- Light-mode checks covered Home, malware, updates, performance, and settings, plus render/overflow checks for the four new routes at 1280 by 800.
- Browser interaction checks covered Cleaner scanning and selection, directory selection, schedule template focus/Escape, expanded run conditions, task reordering, saved custom cleaner selection, diagnostics recording details, and settings section navigation.
- Graph regression tests cover timestamp windows after a pause, bounded sample counts, newest-sample retention, unit conversion, missing readings, and storage snapshot comparability across folders and volumes.
- Simple/Advanced selection is validated through IPC and persisted without changing other preferences. Browser checks covered both themes, all three goal lists, their first real tool routes, platform filtering, view persistence after reload, and a rejected-save error. Both views and the expanded goal lists fit at 1000 by 760.

Visual QA uses labelled sample data. Native scans and destructive operations were not executed during browser review. New explanatory copy uses the English fallback namespace until translations are added.
