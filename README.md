<p align="center">
  <a href="https://usekudu.com"><img src="logo.png" alt="Kudu" width="128" /></a>
</p>

<h1 align="center">Kudu</h1>

<p align="center">
  <b>Free, open-source system cleaner & security scanner for Windows, macOS, and Linux.</b><br/>
  Reclaim disk space. Remove malware. Take back your privacy. All in one app.
</p>

<p align="center">
  <a href="https://github.com/adventdevinc/kudu/stargazers"><img src="https://img.shields.io/github/stars/adventdevinc/kudu?style=flat-square&label=Stars" alt="Stars" /></a>
  <a href="https://github.com/adventdevinc/kudu/releases"><img src="https://img.shields.io/github/v/release/adventdevinc/kudu?style=flat-square" alt="Release" /></a>
  <a href="https://github.com/adventdevinc/kudu/releases"><img src="https://img.shields.io/github/downloads/adventdevinc/kudu/total?style=flat-square&label=Downloads" alt="Downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/adventdevinc/kudu?style=flat-square" alt="License" /></a>
  <a href="https://github.com/adventdevinc/kudu/actions"><img src="https://img.shields.io/github/actions/workflow/status/adventdevinc/kudu/release.yml?style=flat-square&label=Build" alt="Build" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square" alt="Platform" />
</p>

<p align="center">
  <a href="https://github.com/adventdevinc/kudu/releases"><b>Download</b></a> &nbsp;&middot;&nbsp;
  <a href="https://usekudu.com"><b>Website</b></a> &nbsp;&middot;&nbsp;
  <a href="https://usekudu.com/cleaners"><b>Cleaners</b></a> &nbsp;&middot;&nbsp;
  <a href="CLI.md"><b>CLI Docs</b></a>
</p>

---

<p align="center">
  <img src="resources/kudu-animated.gif" alt="Kudu Demo" width="800" />
</p>

## Download

Get the latest installer for your platform from [GitHub Releases](https://github.com/adventdevinc/kudu/releases):

| Platform | Format |
|----------|--------|
| Windows | `.exe` installer |
| macOS | `.dmg` (Intel & Apple Silicon) |
| Linux | `.AppImage` or `.deb` |

## Why Kudu?

Most system cleaners are closed-source, ad-filled, and want your money. Some are barely disguised malware themselves.

Kudu is **100% free, open-source, and transparent**. No ads, no upsells, no telemetry. You can read every line of code, audit every scan, and verify every delete. Built by developers who were tired of recommending CCleaner with a straight face.

## What It Does

<table>
<tr>
<td width="33%" valign="top">

### Cleaning & Optimization
- **System Cleaner** — temp files, logs, caches, crash dumps
- **Browser Cleaner** — caches across all major browsers
- **App Cleaner** — leftover app data
- **Gaming Cleaner** — game launcher & shader caches
- **Registry Cleaner** — broken/orphaned entries
- **Startup Manager** — boot impact analysis
- **Network Cleanup** — DNS, Wi-Fi profiles, ARP cache
- **Disk Analyzer** — interactive treemap of disk usage
- **Debloater** — remove Windows bloatware
- **Driver Manager** — stale driver cleanup
- **Program Uninstaller** — uninstall + leftover cleanup
- **Service Manager** — optimize Windows services
- **Software Updater** — bulk-update via winget

</td>
<td width="33%" valign="top">

### Security & Privacy
- **Malware Scanner** — signature matching, heuristic analysis, Defender integration
- **Privacy Shield** — control 30+ Windows privacy settings (telemetry, ad ID, Cortana, tracking)
- **Secure Delete** — overwrite files with random data before deletion

</td>
<td width="33%" valign="top">

### Monitoring & Tools
- **Performance Monitor** — real-time CPU, memory, disk, network, per-core stats, S.M.A.R.T.
- **System Restore Points** — create restore points before cleaning
- **Cleaning History** — track past sessions & space recovered
- **Scheduled Scans** — daily, weekly, or monthly
- **One-Click Clean** — scan & clean everything in one click
- **[CLI Mode](CLI.md)** — scriptable, no GUI required

</td>
</tr>
</table>

## Languages

Kudu is available in 30 languages:

English, Spanish, French, German, Portuguese, Italian, Japanese, Korean, Chinese (Simplified), Chinese (Traditional), Russian, Arabic, Hindi, Turkish, Dutch, Polish, Swedish, Norwegian, Danish, Finnish, Czech, Thai, Vietnamese, Indonesian, Malay, Ukrainian, Romanian, Greek, Hebrew, Hungarian

## Disclaimer

Kudu is intended for **advanced users** who understand system maintenance. You are responsible for reviewing items before removal. We accept no liability for data loss or system instability. Create backups before cleaning — especially for registry and debloat operations. This software is provided **"as is"** without warranty.

## Contributing

Contributions are welcome! Feel free to open issues, submit PRs, or suggest features.

**Want to add a cleaner for your favorite app?** Kudu's cleaning rules are simple JSON files — no code required. See the [Cleaner Rules Guide](rules/RULES.md) to get started, or browse the [full cleaner directory](https://usekudu.com/cleaners) to see what's already covered.

If you find Kudu useful, consider giving it a star — it helps others discover the project.

## License

[MIT](LICENSE)
