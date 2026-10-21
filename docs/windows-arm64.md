# Windows ARM64

Windows ARM64 releases target Windows 11 on ARM and use native Electron, SQLite, and YARA binaries.

## Build and release

- Run `npm ci` and `npm run package:win:arm64` on a Windows ARM64 machine with the Visual C++ build tools installed.
- Cross-compilation also requires the ARM64 Visual C++ toolchain and target-specific native dependencies. Native Windows ARM64 CI is the supported release path.
- `electron-builder.arm64.yml` extends the Windows configuration, retaining elevation, per-machine installation, and signing settings.
- ARM installers are named `Kudu-Setup-<version>-arm64.exe`. Portable releases include `Kudu-Portable-<version>-arm64.exe` and `Kudu-Portable-<version>-arm64.zip`.
- The packaged updater configuration selects `latest-arm64.yml`. Existing x64 installs retain their filenames and `latest.yml` channel.
- Release verification requires both Windows architectures, their update metadata and checksums, and successful native platform builds before publication.
- Chocolatey and WinGet continue distributing the x64 package. Native ARM64 downloads are available from GitHub Releases and the website once the first release containing them is published.

## Automated coverage

The package smoke workflow builds on `windows-11-arm` and verifies the packaged runtime architecture, bundled resources, SQLite queries, YARA matching, and CLI commands. It also checks the installer metadata checksum and packaged update channel, silently installs and reinstalls through NSIS, and extracts and runs the portable ZIP.

Installer smoke tests run only on disposable GitHub-hosted runners. Their app ID and execution manifest are overridden to avoid interactive UAC prompts and isolate test registry entries. Release builds retain the production app ID, elevation requirements, and Azure signing configuration.

## Release validation still required

Unsigned CI packages do not prove production signing or a download-and-install update between two published versions. Verify those during the first ARM64 release. Before declaring broad device compatibility, also exercise the GUI, elevation, system information, scans, driver tools, startup tasks, and cleanup previews on a physical Windows ARM64 device. Automated smoke tests do not validate every system-changing operation.
