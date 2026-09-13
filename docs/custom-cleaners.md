# Custom cleaners

Custom cleaners are free and local. Open Clean up → Custom cleaners, choose a specific folder, explain the intended contents, and set filename patterns, exclusions, minimum age and recursion depth. Preview before saving. Enabling a definition includes it under Apps in normal desktop cleaner scans and scheduled App cleaning; the builder also offers an explicit confirmation to clean the reviewed files immediately.

The initial restricted format supports files only. It shares the existing scan-item cache, recent-file protection, global exclusions, cleanup engine, accounting and opt-in deletion log. Bundled cleaner rules continue to use their existing schema and loader. Custom definitions do not support bundled native maintenance, executable scripts, regex, remote rule feeds or automatic directory removal.

## JSON authoring and import

Definitions live in `custom-cleaners.json` under Kudu's local data directory (the Kudu-Dev subdirectory in development). The visual builder and manual JSON editor use the same main-process validation. Use the native Import/Export actions for portable files; imports are always disabled copies with fresh IDs and cannot replace bundled or existing definitions. Absolute folder paths need reviewing when moving between computers. Exports contain those paths and are not encrypted.

An exported file has `{ "version": 1, "rules": [...] }`. Each rule contains:

```json
{
  "version": 1,
  "id": "custom-12345678-1234-4123-8123-123456789012",
  "name": "My application temp files",
  "description": "Old temporary files created by my application",
  "platform": "win32",
  "root": "C:\\Users\\me\\Downloads\\my-app-temp",
  "patterns": ["*.tmp", "cache-*.log"],
  "excludePatterns": ["keep*"],
  "excludeDirectories": ["retained", "sessions/current"],
  "minAgeDays": 7,
  "maxDepth": 1,
  "enabled": false
}
```

The manual editor accepts a single definition; a new definition can use an empty ID before preview. Import files require valid namespaced UUIDs, which are replaced with new IDs on import. There are at most 20 saved rules in a 128 KB versioned, atomically replaced file. Corrupt or unsupported files fail without overwriting the original; individual invalid or duplicate entries are ignored on read (and logged) so the remaining definitions stay usable.

Patterns match basenames using `*` and `?`, with no regular-expression execution. There are at most 20 patterns/exclusions per field. Folder exclusions are literal relative paths using `/`; parent traversal and directory wildcards are forbidden. Filename and folder-exclusion matching is case-insensitive on Windows and macOS (NTFS and default APFS volumes ignore case). Minimum age is 1–3650 days; depth is 0–8. Global recent-file protection can further increase the required age.

## Preview and deletion safety

A preview examines at most 50,000 entries, returns at most 2,000 matches and runs for at most ten seconds. It yields between batches and supports cancellation. Results are paginated in groups of 100. An incomplete/cancelled preview cannot save, enable or clean a definition. Narrow broad folders or patterns before proceeding. Normal App scans have an additional shared 30-second/10,000-match custom-rule budget. A rule that fails, exceeds the budget or cannot complete its preview is skipped and logged; it never fails the bundled Applications results.

System/protected folders, profile roots, Kudu data, credential and source-control metadata, symbolic links, junctions and nested mounted volumes are excluded. The scanner never offers a directory or multiply linked file. Main-owned per-item guards travel with cached IDs through every common cleaner entry point. Immediately before deletion they check the current rule and enabled state, age/exclusions, root and ancestor identity, canonical containment, and original file device/inode/size/timestamps. Changed or expired candidates are skipped. A file-only deletion uses unlink, never recursive directory removal, even if a path is replaced with a directory. Secure overwrite retains the existing identity/no-follow checks and cannot recurse for custom files.

Previews expire after ten minutes and are invalidated by replacement scans. Clean results distinguish selected/deleted/skipped items and measured bytes; the builder records a normal cleanup-history entry. Detailed paths remain subject to the existing deletion-log preference. No Cloud upload, subscription check or remote execution is introduced by this feature. CLI and Cloud-agent rule discovery continue to use bundled definitions.
