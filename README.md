<p align="center">
  <a href="https://usekudu.com"><img src="logo.png" alt="Kudu" width="128" /></a>
</p>

<h1 align="center">Kudu</h1>

<p align="center">
  Free, open-source system cleaner and security scanner for Windows, macOS, and Linux.
</p>

<p align="center">
  <a href="https://github.com/adventdevinc/kudu/releases"><img src="https://img.shields.io/github/v/release/adventdevinc/kudu?style=flat-square" alt="Release" /></a>
  <a href="https://github.com/adventdevinc/kudu/releases"><img src="https://img.shields.io/github/downloads/adventdevinc/kudu/total?style=flat-square&label=Downloads" alt="Downloads" /></a>
  <a href="https://github.com/adventdevinc/kudu/actions"><img src="https://img.shields.io/github/actions/workflow/status/adventdevinc/kudu/release.yml?style=flat-square&label=Build" alt="Build" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/adventdevinc/kudu?style=flat-square" alt="License" /></a>
</p>

<p align="center">
  <a href="https://github.com/adventdevinc/kudu/releases"><b>Download</b></a> &nbsp;&middot;&nbsp;
  <a href="https://usekudu.com"><b>Website</b></a> &nbsp;&middot;&nbsp;
  <a href="https://usekudu.com/cleaners"><b>Cleaners</b></a> &nbsp;&middot;&nbsp;
  <a href="CLI.md"><b>CLI</b></a>
</p>

<p align="center">
  <img src="resources/kudu-animated.gif" alt="Kudu Demo" width="800" />
</p>

## Overview

Kudu reclaims disk space, removes malware, and protects your privacy — without ads, bundled software, or upsells. Everything runs locally, and every line of code is open for you to audit.

It covers system, browser, app, and game cache cleaning; registry and startup management; a disk analyzer; a malware scanner; privacy controls; a software updater; performance monitoring; scheduled scans; and a scriptable [CLI](CLI.md). See the [website](https://usekudu.com) for the full feature list and the [cleaner directory](https://usekudu.com/cleaners) for every supported app.

Available in 30 languages.

## Install

Download the latest release for your platform from [GitHub Releases](https://github.com/adventdevinc/kudu/releases).

| Platform | Formats                                    |
| -------- | ------------------------------------------ |
| Windows  | `.exe` installer, portable ZIP or EXE      |
| macOS    | `.dmg` (Intel and Apple Silicon)           |
| Linux    | `.AppImage` or `.deb` (x64, arm64)         |

The installer is recommended for automatic updates and scheduled scans on startup. Portable builds keep settings in AppData and are updated manually.

## Contributing

Issues, pull requests, and feature suggestions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and conventions.

Cleaning rules are plain JSON — no code required to add support for a new app. Start with the [Cleaner Rules Guide](rules/RULES.md).

## Support

Kudu's desktop tools are free for everyone. If it saves you time, consider [sponsoring development](https://usekudu.com/sponsors) or starring the repo.

## Disclaimer

Kudu removes files from your system by design. Review items before removal; the software is provided "as is" without warranty, and we accept no liability for data loss or system instability.

## License

[MIT](LICENSE)
