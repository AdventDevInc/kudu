# Custom cleaning folders

Custom cleaning folders let you review disposable files in an exact folder on any local drive, including caches used by portable apps. You do not need to edit Kudu's built-in JSON rules or rebuild the app.

## Add and clean a folder

1. Open **Settings → Custom cleaning folders**.
2. Enter a name, then use **Browse** or enter the full absolute folder path. For example, `Q:\PortableApps\ExampleApp\cache` on Windows or `/home/alex/portable/example/cache` on Linux. Windows paths using forward slashes, such as `Q:/PortableApps/ExampleApp/cache`, also work.
3. Choose **Save folder**. This saves a target; it does not scan or delete files.
4. Close the app that uses the cache, then choose **Scan and review**.
5. Inspect the relative file paths, sizes, and modification dates. Nothing is selected automatically. Check individual files or use **Select shown files** to select the currently displayed rows. **Show 50 more** reveals more rows without selecting them.
6. Choose **Move selected to Trash**, review the selected count, size, and folder, then confirm.

Saved targets persist across app restarts and updates. **Remove target** removes only the saved configuration; it never deletes the folder or its files. To change a target's name or path, remove it and add it again.

## Choose the target carefully

Every eligible regular file in the selected folder and its subfolders appears in the preview. Kudu cannot determine whether these files are disposable. Only add specific cache, temporary-file, or log folders whose purpose you understand. Do not add an entire portable application, documents folder, or a location containing settings, extensions, login tokens, or user content. A folder named `cache` is not automatically safe to empty.

Custom folders are **manual only**. They are separate from built-in Cleaner categories, **Clean All**, schedules, the CLI, and Cloud cleanup. The preview includes files of every age; the Cleaner's **Skip recent files** preference does not filter it. Review the modification dates and close the app before selecting files. Custom cleanup always uses the OS Trash; the secure-delete preference does not apply. There is no permanent-delete fallback if Trash is unavailable.

## Limits and safeguards

- Use exact local absolute paths. Wildcards, template variables, relative paths, and network/UNC paths are not supported.
- Drive roots, home folders, broad standard user folders, system trees, and Kudu recovery folders are blocked. Choose a specific folder beneath an allowed location.
- Up to 100 targets can be saved. Targets cannot overlap one another.
- Settings exclusions apply both during scanning and immediately before cleanup.
- Symbolic links, junctions, hard-linked files, and mounted filesystems beneath a target are skipped. Empty directories and the target folder itself are left in place.
- A scan examines up to 10,000 entries, 20 nested folder levels, or 30 seconds. Inaccessible or changed directories and scan limits produce a partial-preview notice. Only files listed in that preview can be selected.
- Cleanup rechecks folder and file identity. Changed, replaced, missing, newly excluded, or linked files are skipped. A new scan or a saved-target change expires the previous preview.

## Restoring files

Files are staged in a `Kudu Custom Folder Recovery-…` directory beside their original location before being moved to the OS Trash. This protects against a file being replaced between preview and cleanup. When restoring from the OS Trash, the restore destination may be that recovery directory; move the restored file back to its original folder yourself. The empty recovery directory is retained so the restore destination remains available.

If Trash fails, Kudu tries to restore the original path without overwriting anything. If that cannot be done safely, it preserves the file in the recovery directory and displays its exact path for manual recovery. Recovery directories are skipped by later custom-folder scans.

## How this differs from built-in rule JSON

The [Cleaner Rules Guide](rules/RULES.md) describes contributing rules to Kudu's source code. Those JSON files are bundled into the application at build time; they are not user configuration loaded from beside the installed executable. Template variables make contributed rules portable across machines, but the rule path resolver also accepts literal absolute paths. A hardcoded personal drive path is therefore technically valid in a source rule, but is unsuitable for a shared built-in rule.

For personal paths on another drive, use **Custom cleaning folders**. Adding a new drive template variable or editing packaged files is unnecessary. Kudu 3.8.0 did not provide this custom-folder UI or a CLI option for adding personal targets; this feature is available in releases containing the custom-folder implementation.
