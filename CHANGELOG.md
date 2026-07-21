# [1.45.0](https://github.com/adventdevinc/kudu/compare/v1.44.1...v1.45.0) (2026-07-21)
## [1.44.1](https://github.com/adventdevinc/kudu/compare/v1.44.0...v1.44.1) (2026-06-11)
# [1.44.0](https://github.com/adventdevinc/kudu/compare/v1.43.0...v1.44.0) (2026-06-09)


### Bug Fixes

* **main:** recover from fatal GPU process launch failure on Windows ([#203](https://github.com/adventdevinc/kudu/issues/203)) ([#206](https://github.com/adventdevinc/kudu/issues/206)) ([736912b](https://github.com/adventdevinc/kudu/commit/736912b3a5e7e95d8af5183a9710550a74c298a0))
# [1.43.0](https://github.com/adventdevinc/kudu/compare/v1.42.0...v1.43.0) (2026-05-29)


### Features

* **malware:** allowlist false positives so trusted files stop being flagged ([#193](https://github.com/adventdevinc/kudu/issues/193)) ([c752129](https://github.com/adventdevinc/kudu/commit/c752129292348f7b867c21be442643b8b47d8445))
* **malware:** surface quarantine reason and add quick access ([#190](https://github.com/adventdevinc/kudu/issues/190)) ([ef155f9](https://github.com/adventdevinc/kudu/commit/ef155f904abecf368d36772430747f0e3d877be6))
# [1.42.0](https://github.com/adventdevinc/kudu/compare/v1.41.0...v1.42.0) (2026-05-24)


### Bug Fixes

* **privacy:** remove Linux USB mass storage blocking ([1514de2](https://github.com/adventdevinc/kudu/commit/1514de2838c5068a831cec453affb8aa220c3dbf)), closes [#187](https://github.com/adventdevinc/kudu/issues/187)
* **registry:** persist deselected tweaks across restarts ([#172](https://github.com/adventdevinc/kudu/issues/172)) ([#189](https://github.com/adventdevinc/kudu/issues/189)) ([59b3a93](https://github.com/adventdevinc/kudu/commit/59b3a93c2357d206228c0e129ddad944ee963df9))
* **scanner:** require behavioral signal for Suspicious.PE heuristic ([#156](https://github.com/adventdevinc/kudu/issues/156)) ([ecc1a56](https://github.com/adventdevinc/kudu/commit/ecc1a5616c372552c790e3b152be1ad417f8efeb))
# [1.41.0](https://github.com/adventdevinc/kudu/compare/v1.40.0...v1.41.0) (2026-05-19)


### Bug Fixes

* **diagnostics:** log renderer crashes and harden updater broadcast ([#176](https://github.com/adventdevinc/kudu/issues/176)) ([48afafa](https://github.com/adventdevinc/kudu/commit/48afafad2fefc493b12b1be92a4037df49d29304))
* **shortcuts:** don't flag File Explorer / shell-namespace .lnk files as dead ([#174](https://github.com/adventdevinc/kudu/issues/174)) ([c112943](https://github.com/adventdevinc/kudu/commit/c1129439dfb018771e114dfdf827c9cd483c2d2b))


### Features

* **registry-cleaner:** targeted backup mode (default) ([#175](https://github.com/adventdevinc/kudu/issues/175)) ([6beb61a](https://github.com/adventdevinc/kudu/commit/6beb61a05fb2dd3038940ef7affbcb5a135d368d))
* **settings:** configurable backup folder ([#160](https://github.com/adventdevinc/kudu/issues/160)) ([8c4a8a5](https://github.com/adventdevinc/kudu/commit/8c4a8a591ea329f40ab5bfd90935a0439d894368))
# [1.40.0](https://github.com/adventdevinc/kudu/compare/v1.39.0...v1.40.0) (2026-05-02)


### Features

* **context-menu:** Windows shell-extension cleaner ([#151](https://github.com/adventdevinc/kudu/issues/151)) ([459c2d4](https://github.com/adventdevinc/kudu/commit/459c2d4895ff5be44ccd8a077e49fdddd5da8307))
* **disk-maintenance:** SSD TRIM page with multi-select and safety rails ([#150](https://github.com/adventdevinc/kudu/issues/150)) ([dd1846c](https://github.com/adventdevinc/kudu/commit/dd1846cc65551d744a1442847afd98ba1d566d88))
* **firewall-audit:** Windows Defender Firewall rules audit ([#149](https://github.com/adventdevinc/kudu/issues/149)) ([7405492](https://github.com/adventdevinc/kudu/commit/740549218412f43674b052bc0a1c9814a7d502d0))
* **firewall,context-menu:** hide built-in Windows entries by default ([#152](https://github.com/adventdevinc/kudu/issues/152)) ([9f66901](https://github.com/adventdevinc/kudu/commit/9f66901ab328f3ac83cb754d86ad0328a5856571))
# [1.39.0](https://github.com/adventdevinc/kudu/compare/v1.38.0...v1.39.0) (2026-04-30)


### Bug Fixes

* **registry-cleaner:** prune Kudu Backups to last 3 runs ([#146](https://github.com/adventdevinc/kudu/issues/146)) ([4056c47](https://github.com/adventdevinc/kudu/commit/4056c479014d45b8925258a7e0247ca75a2db267))
* **software-updater:** resolve brew path on macOS GUI launches ([#147](https://github.com/adventdevinc/kudu/issues/147)) ([defbe22](https://github.com/adventdevinc/kudu/commit/defbe22a156adc7da971d4f518ee72fbe2f72c81))
# [1.38.0](https://github.com/adventdevinc/kudu/compare/v1.37.0...v1.38.0) (2026-04-28)


### Bug Fixes

* **registry-cleaner:** handle trailing backslashes in value names ([#143](https://github.com/adventdevinc/kudu/issues/143)) ([3acfc74](https://github.com/adventdevinc/kudu/commit/3acfc7405d516b4ca3ae94ea4d2b06a8b84c4617))
# [1.37.0](https://github.com/adventdevinc/kudu/compare/v1.36.0...v1.37.0) (2026-04-28)


### Bug Fixes

* **cloud:** handle pusher-js v8.5+ named export breaking constructor ([419c63a](https://github.com/adventdevinc/kudu/commit/419c63a727b602b226f9183e34f6aefeddca8d5b))
# [1.36.0](https://github.com/adventdevinc/kudu/compare/v1.35.0...v1.36.0) (2026-04-23)
# [1.35.0](https://github.com/adventdevinc/kudu/compare/v1.34.0...v1.35.0) (2026-04-17)


### Bug Fixes

* **drivers:** skip driver scans on non-Windows platforms ([#131](https://github.com/adventdevinc/kudu/issues/131)) ([28df495](https://github.com/adventdevinc/kudu/commit/28df4953a9f6a01d5d6491d1c2202e77cf80d3ff))
* **game-mode:** preserve snapshot on partial failure while releasing toggle ([50052e9](https://github.com/adventdevinc/kudu/commit/50052e9adb18e571a9498cfc972c92b2dfc86cb1))
* **game-mode:** unstick active state when deactivation partially fails ([bf51144](https://github.com/adventdevinc/kudu/commit/bf51144e9650cebf8c0f75c5d28f0584a8caa256))
* **game-mode:** unstick active state when deactivation partially fails ([#132](https://github.com/adventdevinc/kudu/issues/132)) ([a467a28](https://github.com/adventdevinc/kudu/commit/a467a283563b083f30a8aeab37478d068f749a75))
* **privacy:** show custom prompt in macOS admin dialog ([e3ef0b1](https://github.com/adventdevinc/kudu/commit/e3ef0b1ba40ef9f6502418dc5686862cb9e58e6e))
# [1.34.0](https://github.com/adventdevinc/kudu/compare/v1.33.0...v1.34.0) (2026-04-05)


### Bug Fixes

* **linux:** resolve grey window when relaunched as root via pkexec ([#118](https://github.com/adventdevinc/kudu/issues/118)) ([b83d448](https://github.com/adventdevinc/kudu/commit/b83d448d2f64a4f8ed760b77dbe3119def42fe3b))
* **registry:** prevent orphaned reg.exe/powershell processes on timeout ([#117](https://github.com/adventdevinc/kudu/issues/117)) ([870bad3](https://github.com/adventdevinc/kudu/commit/870bad39799351687088ca36ca3e3a8f94b1a8d9))
* **ui:** record history entry after driver scan so dashboard highlights completion ([#116](https://github.com/adventdevinc/kudu/issues/116)) ([0501600](https://github.com/adventdevinc/kudu/commit/0501600a6aac716a28f91b83b858825a87887edc))


### Features

* **updater:** add package manager selector to Software Updater page ([#113](https://github.com/adventdevinc/kudu/issues/113)) ([318b4b7](https://github.com/adventdevinc/kudu/commit/318b4b74697844cb33037b049b8b88e6359daac7))
# [1.33.0](https://github.com/adventdevinc/kudu/compare/v1.32.0...v1.33.0) (2026-04-03)


### Bug Fixes

* **ui:** clarify privacy toggle toast messages to avoid ambiguity ([d9ebdf4](https://github.com/adventdevinc/kudu/commit/d9ebdf49244e309fc7a0bcdbb2fb31bf0cae5da8))


### Features

* **updater:** add Chocolatey as optional Windows package manager ([#111](https://github.com/adventdevinc/kudu/issues/111)) ([e030f6b](https://github.com/adventdevinc/kudu/commit/e030f6b041ac2f3ed3c930defa46167b697b0d02))
# [1.32.0](https://github.com/adventdevinc/kudu/compare/v1.31.0...v1.32.0) (2026-03-31)


### Bug Fixes

* **elevation:** disable renderer sandbox when running as root on Linux ([#107](https://github.com/adventdevinc/kudu/issues/107)) ([b7329d4](https://github.com/adventdevinc/kudu/commit/b7329d453436d72a619ae27af67029963786f6b9))
* **malware:** remove hardcoded signatures to prevent AV false positives ([#106](https://github.com/adventdevinc/kudu/issues/106)) ([f1e4d3e](https://github.com/adventdevinc/kudu/commit/f1e4d3e4eea7a0038668d2213f2ce0faf5690f15))
* **registry:** kill process tree on timeout to prevent zombie reg.exe ([#105](https://github.com/adventdevinc/kudu/issues/105)) ([7ec25e7](https://github.com/adventdevinc/kudu/commit/7ec25e7feac4eb5a33ca4b5467f24dc2cbd16694))


### Features

* **settings:** add Protect Recycle Bin setting ([#104](https://github.com/adventdevinc/kudu/issues/104)) ([7b52934](https://github.com/adventdevinc/kudu/commit/7b5293435b0660f9f8e38c6d6b9e6d28af052f02))
# [1.31.0](https://github.com/adventdevinc/kudu/compare/v1.30.0...v1.31.0) (2026-03-29)


### Bug Fixes

* **mac:** use correct memory metric to match Activity Monitor ([#93](https://github.com/adventdevinc/kudu/issues/93)) ([eab0228](https://github.com/adventdevinc/kudu/commit/eab0228bf697076da6f667abe862f40279732a0f))


### Features

* **game-mode:** auto-detect games and activate/deactivate automatically ([#95](https://github.com/adventdevinc/kudu/issues/95)) ([a7d523b](https://github.com/adventdevinc/kudu/commit/a7d523b7194e8ff80b9c2628fe8e7b013f57150e))
* **malware:** WASM-based YARA signature engine ([#102](https://github.com/adventdevinc/kudu/issues/102)) ([2ac60d1](https://github.com/adventdevinc/kudu/commit/2ac60d1720abc92d18b7bf5784fbab38b043d7de))
* **rules:** add Zen Browser, Scoop, AWS CLI, and gcloud cleaners ([#94](https://github.com/adventdevinc/kudu/issues/94)) ([68e68aa](https://github.com/adventdevinc/kudu/commit/68e68aa90ecfd700cd4d5c71ad9f64460e9beb2f))
# [1.30.0](https://github.com/adventdevinc/kudu/compare/v1.29.0...v1.30.0) (2026-03-28)


### Bug Fixes

* **mac:** remove broken relaunch-as-admin on macOS ([#91](https://github.com/adventdevinc/kudu/issues/91)) ([d84843f](https://github.com/adventdevinc/kudu/commit/d84843fa654956311a50fb40d82bf258590cdeeb))
* malware auto-scan, exclusions, schedule minutes, network cleaning ([#92](https://github.com/adventdevinc/kudu/issues/92)) ([592a23a](https://github.com/adventdevinc/kudu/commit/592a23a990164eadf9e2fcb251936e7e2878fa12))
# [1.29.0](https://github.com/adventdevinc/kudu/compare/v1.28.0...v1.29.0) (2026-03-27)


### Bug Fixes

* **elevation:** fix relaunch-as-admin on all platforms ([#88](https://github.com/adventdevinc/kudu/issues/88)) ([4943778](https://github.com/adventdevinc/kudu/commit/4943778ee87cbb192f75e850908737a59d7c1389))
* **linux:** fix deb install failures on Linux Mint ([#84](https://github.com/adventdevinc/kudu/issues/84)) ([4750f88](https://github.com/adventdevinc/kudu/commit/4750f88f79d12faf7ca64cd94c051769e1c0e490))
* **mac:** sharp retina tray icon with bundled size variants ([#89](https://github.com/adventdevinc/kudu/issues/89)) ([8724a85](https://github.com/adventdevinc/kudu/commit/8724a857eac51a09c04e8e1dbe7f5d1735aac34c))
* **ui:** restore i18n for monitoring submenu and fix badge count ([313c79b](https://github.com/adventdevinc/kudu/commit/313c79b56c92f7a447af15b42b51dea26c06a340))


### Features

* **rules:** add missing cleaning rules for 25+ apps and system targets ([#90](https://github.com/adventdevinc/kudu/issues/90)) ([65f6ce6](https://github.com/adventdevinc/kudu/commit/65f6ce6922ce2102e82fbfc2bf21feed9c3b5443))
# [1.28.0](https://github.com/adventdevinc/kudu/compare/v1.27.0...v1.28.0) (2026-03-26)


### Bug Fixes

* **rules:** remove Login Data from database optimizer to reduce AV false positives ([5711783](https://github.com/adventdevinc/kudu/commit/5711783b2b8be08a538b20ee9b204bcc4ad35ff0))


### Features

* **cleaner:** add Environment Variable & PATH cleaner ([#80](https://github.com/adventdevinc/kudu/issues/80)) ([7ad17bd](https://github.com/adventdevinc/kudu/commit/7ad17bd287635ccfc42d108d947e46f42fae5095))
* **cleaner:** add open file location button to scan results ([#83](https://github.com/adventdevinc/kudu/issues/83)) ([80dd048](https://github.com/adventdevinc/kudu/commit/80dd04815c7971085546abd828b78357072f4012))
* **cleaner:** add rich post-clean summary receipt UI ([#82](https://github.com/adventdevinc/kudu/issues/82)) ([6b9dd9c](https://github.com/adventdevinc/kudu/commit/6b9dd9c2f21f6ec6aba24a0978ff374da8d64ee9))
* **disk:** add dedicated Disk Repair page with CHKDSK support ([#81](https://github.com/adventdevinc/kudu/issues/81)) ([d6288cb](https://github.com/adventdevinc/kudu/commit/d6288cb430a0a31a9dcae9829b6d1f207500b910))
# [1.27.0](https://github.com/adventdevinc/kudu/compare/v1.26.0...v1.27.0) (2026-03-26)


### Bug Fixes

* **elevation:** share config and fix paste when relaunched as admin on macOS/Linux ([#75](https://github.com/adventdevinc/kudu/issues/75)) ([0316aa5](https://github.com/adventdevinc/kudu/commit/0316aa5ef2e1e3845b17bb5b53ab5540c68799fa))
* **privacy:** use locale-independent XML to detect scheduled task state ([#79](https://github.com/adventdevinc/kudu/issues/79)) ([5261780](https://github.com/adventdevinc/kudu/commit/52617808d11e921c2c342fd931d1be9687ce4e62))
* **ui:** disable hardware acceleration to prevent black window on incompatible GPUs ([#76](https://github.com/adventdevinc/kudu/issues/76)) ([4361b60](https://github.com/adventdevinc/kudu/commit/4361b603b04263737120b7634483613b5f9e2330))


### Features

* **cloud:** add dedicated Cloud page and Breach Monitor ([#78](https://github.com/adventdevinc/kudu/issues/78)) ([6d470e3](https://github.com/adventdevinc/kudu/commit/6d470e3d664ef848e7d432ad81078992e5a8776c))
* **uninstaller:** force remove option for failed uninstalls ([#74](https://github.com/adventdevinc/kudu/issues/74)) ([9571c7c](https://github.com/adventdevinc/kudu/commit/9571c7c8f82439ed67c75816431464d6ff066b92))
# [1.26.0](https://github.com/adventdevinc/kudu/compare/v1.25.0...v1.26.0) (2026-03-25)


### Bug Fixes

* **i18n:** platform-aware onboarding text ([#70](https://github.com/adventdevinc/kudu/issues/70)) ([8b6457d](https://github.com/adventdevinc/kudu/commit/8b6457d57cd85d0e1c6f44bb12bfb14edd51c152))
* **ui:** report failure when startup/privacy toggles don't take effect ([09086f3](https://github.com/adventdevinc/kudu/commit/09086f3d784bf826ca88ea8ee9bca8af71c148e0))
* **ui:** resolve black screen on first launch for slow machines ([2c6a573](https://github.com/adventdevinc/kudu/commit/2c6a5731ef74c111d26f70845143041693680127))
* **ui:** show real-time progress during cleaner clean operation ([#72](https://github.com/adventdevinc/kudu/issues/72)) ([46e3d01](https://github.com/adventdevinc/kudu/commit/46e3d012a4276508fa7e634aacfb8d90f291485e))


### Features

* **cloud:** AI safety ratings for Startup Manager and Uninstaller ([#73](https://github.com/adventdevinc/kudu/issues/73)) ([37bc5db](https://github.com/adventdevinc/kudu/commit/37bc5dbe3fd416e982340607abd6035d2e002df7))
* **darwin:** comprehensive macOS platform improvements ([#71](https://github.com/adventdevinc/kudu/issues/71)) ([2362321](https://github.com/adventdevinc/kudu/commit/2362321167ab55e17bf30d50b9daac0ed916a3de))
* **ui:** add dark/light/system theme toggle ([#69](https://github.com/adventdevinc/kudu/issues/69)) ([c57bffb](https://github.com/adventdevinc/kudu/commit/c57bffbe2862e69b7bcca94390e0ef9ea2be5172))
# [1.25.0](https://github.com/adventdevinc/kudu/compare/v1.24.0...v1.25.0) (2026-03-24)


### Bug Fixes

* **encoding:** correct UTF-8 handling for accented characters ([#68](https://github.com/adventdevinc/kudu/issues/68)) ([38f3e2d](https://github.com/adventdevinc/kudu/commit/38f3e2df9b64824b80e5ee8a2399759290a9e205))
* patch 4 high-severity bugs from codebase review ([#65](https://github.com/adventdevinc/kudu/issues/65)) ([58acebf](https://github.com/adventdevinc/kudu/commit/58acebfe2b2154e9db8166cf15a2e4b9041c3ce1)), closes [hi#severity](https://github.com/hi/issues/severity)


### Features

* **ci:** auto-translate workflow & remove local git hooks ([#64](https://github.com/adventdevinc/kudu/issues/64)) ([a7ccf64](https://github.com/adventdevinc/kudu/commit/a7ccf6440152ca929823c19b9a47f714717c7dc1))
# [1.24.0](https://github.com/adventdevinc/kudu/compare/v1.23.0...v1.24.0) (2026-03-24)


### Bug Fixes

* **privacy:** make privacy shield toggles bidirectional ([#63](https://github.com/adventdevinc/kudu/issues/63)) ([e72cfc2](https://github.com/adventdevinc/kudu/commit/e72cfc2508c6e2a124de817640fade9a2e8d12b9))
* **renderer:** prevent blank screen when preload fails to load ([a684ff9](https://github.com/adventdevinc/kudu/commit/a684ff9c7690e5e4de26a60ec9774c1e3a91c5f9))


### Features

* **malware:** add quarantine management UI ([#62](https://github.com/adventdevinc/kudu/issues/62)) ([1ecf642](https://github.com/adventdevinc/kudu/commit/1ecf642faf79484d18f03d170ac8217235a04cb2))
# [1.23.0](https://github.com/adventdevinc/kudu/compare/v1.22.0...v1.23.0) (2026-03-24)


### Bug Fixes

* **software-updater:** fix winget parsing bugs and add ignore feature ([#59](https://github.com/adventdevinc/kudu/issues/59)) ([a685406](https://github.com/adventdevinc/kudu/commit/a685406f19b46e0bcc5e11a1c0363dd08eda07d4))
# [1.22.0](https://github.com/adventdevinc/kudu/compare/v1.21.1...v1.22.0) (2026-03-23)


### Bug Fixes

* **elevation:** wait for macOS admin prompt before exiting ([7d296bf](https://github.com/adventdevinc/kudu/commit/7d296bf1d28e8a16b76e37db24a4ce31371a5db8))
* **settings:** remove custom cloud server URL setting ([#50](https://github.com/adventdevinc/kudu/issues/50)) ([9fbd92b](https://github.com/adventdevinc/kudu/commit/9fbd92b1647a2f2206ee667a9f69e4e6bf5ae5f3))
* **sidebar:** hide Vulnerabilities item when cloud is disconnected ([49a1f3a](https://github.com/adventdevinc/kudu/commit/49a1f3a6e94046292e889587eeb037269e72e3f3))
* **sidebar:** widen flyout submenu to prevent text wrapping ([032fe59](https://github.com/adventdevinc/kudu/commit/032fe59fd4a72585cdd857bf60f2f255424b9be8))
* **startup:** fall back to Run key when Task Scheduler fails ([#51](https://github.com/adventdevinc/kudu/issues/51)) ([ac70237](https://github.com/adventdevinc/kudu/commit/ac70237ae4ba12f332d7b15973ba0c87bc9790ee))


### Features

* **a11y:** add ARIA labels, keyboard nav, and screen reader support ([#57](https://github.com/adventdevinc/kudu/issues/57)) ([56e68fc](https://github.com/adventdevinc/kudu/commit/56e68fce87eb5e54074591466d443cbc37f92878))
* **browsers:** add CatsXP, LibreWolf, Waterfox, and Floorp support ([#48](https://github.com/adventdevinc/kudu/issues/48)) ([c990593](https://github.com/adventdevinc/kudu/commit/c99059311200c03fd1ae7e0a2fd719b5f5fe49f6))
* **disk-tools:** add standalone File Shredder tool ([#53](https://github.com/adventdevinc/kudu/issues/53)) ([9cfdce8](https://github.com/adventdevinc/kudu/commit/9cfdce881ef3dd84d6d0e17e46d0c9b47cf336c7))
* **game-mode:** redesign hero section with animated visuals and category theming ([ec5645a](https://github.com/adventdevinc/kudu/commit/ec5645a1d37591519b5cc22e42aa9f8abcc61f27))
* **privacy:** expand macOS Privacy Shield from 20 to 35 settings ([#56](https://github.com/adventdevinc/kudu/issues/56)) ([0e31199](https://github.com/adventdevinc/kudu/commit/0e31199bdd912cde807eaab9bd35a382876985a8))
* **rules:** add Flatpak/Snap/Homebrew cleaning coverage ([#52](https://github.com/adventdevinc/kudu/issues/52)) ([2006078](https://github.com/adventdevinc/kudu/commit/2006078b6f0fe3fa4cc1c78c8eb08681e3d3eed5))
## [1.21.1](https://github.com/adventdevinc/kudu/compare/v1.21.0...v1.21.1) (2026-03-23)


### Bug Fixes

* **build:** add zip target for macOS auto-updates ([290f492](https://github.com/adventdevinc/kudu/commit/290f49256f8dc5cae175778e8291740f4300886a))


### Features

* **ui:** show badge counts on flyout submenu items ([d67a38d](https://github.com/adventdevinc/kudu/commit/d67a38dc901aa667832f1c26e8f1081e7d7cdf7d))
# [1.21.0](https://github.com/adventdevinc/kudu/compare/v1.20.0...v1.21.0) (2026-03-23)


### Features

* **cloud:** add firewallStatus to Linux health reports ([#47](https://github.com/adventdevinc/kudu/issues/47)) ([3eaab1d](https://github.com/adventdevinc/kudu/commit/3eaab1d3b877f2412883bd5dad6799517e40d787))
# [1.20.0](https://github.com/adventdevinc/kudu/compare/v1.19.1...v1.20.0) (2026-03-22)


### Bug Fixes

* **ci:** remove unsupported --release-notes flag from wingetcreate ([83b61fc](https://github.com/adventdevinc/kudu/commit/83b61fc4a05d9441da86a1aadf8676bd50fe0986))


### Features

* **cve:** add client-side false positive filter and deduplication ([0571dfb](https://github.com/adventdevinc/kudu/commit/0571dfba54751afab708e296cf806c10cd9567df))
* **disk-tools:** add Large File Finder and Empty Folder Cleaner ([08403eb](https://github.com/adventdevinc/kudu/commit/08403eb1b3d7f14355d367eab074888c1c70c2c1))
* **ui:** update sidebar, dashboard, components, and locale translations ([38e1683](https://github.com/adventdevinc/kudu/commit/38e1683d033cc51b9a62dfbfd00e6fb81c79eda9))
## [1.19.1](https://github.com/adventdevinc/kudu/compare/v1.19.0...v1.19.1) (2026-03-22)


### Features

* **cve:** show only critical/high vulns, add descriptions and NVD links ([bb72b4d](https://github.com/adventdevinc/kudu/commit/bb72b4d55ef88b8a6e17b06537e714a1c7e4161a))
# [1.19.0](https://github.com/adventdevinc/kudu/compare/v1.18.0...v1.19.0) (2026-03-22)


### Bug Fixes

* use Get-CimInstance for driver scans and propagate update errors ([ba47ee7](https://github.com/adventdevinc/kudu/commit/ba47ee795ab9ee093fb3d20bd61b1da2b948e8db))


### Features

* add CVE vulnerability scanner (cloud-powered) ([#46](https://github.com/adventdevinc/kudu/issues/46)) ([68a786b](https://github.com/adventdevinc/kudu/commit/68a786b3a02c5dc29b19c826936427afe50ca019))
# [1.18.0](https://github.com/adventdevinc/kudu/compare/v1.17.0...v1.18.0) (2026-03-22)


### Bug Fixes

* **ci:** trigger website deploy on release and add release notes to winget manifest ([caff018](https://github.com/adventdevinc/kudu/commit/caff01865ac6953af1bc9940de34441e26ec995d))
* **privacy:** disable stealth mode toggle when macOS firewall is off ([#40](https://github.com/adventdevinc/kudu/issues/40)) ([e778766](https://github.com/adventdevinc/kudu/commit/e77876618ec793073b4e960a7d5b4c6d498281b4))


### Features

* add duplicate file finder tool ([#43](https://github.com/adventdevinc/kudu/issues/43)) ([6e74a20](https://github.com/adventdevinc/kudu/commit/6e74a202cf4017537160dc5c5f1d9942e3775311))
* add Game Mode for Windows gaming optimization ([#44](https://github.com/adventdevinc/kudu/issues/44)) ([7d20579](https://github.com/adventdevinc/kudu/commit/7d2057999291311d6e845775ba2060cb07c6714f))
* **cli:** verbose/quiet modes, granular exit codes, JSON audit, Prometheus metrics ([#39](https://github.com/adventdevinc/kudu/issues/39)) ([e24815e](https://github.com/adventdevinc/kudu/commit/e24815e1d00a54c207c84b01574a567a04556d84))
* **cloud:** notify renderer when threat blacklist is updated ([53b71c8](https://github.com/adventdevinc/kudu/commit/53b71c84ea3cde622f7e49e720f7de441f3df55e))
* rework dashboard as Command Center layout ([#45](https://github.com/adventdevinc/kudu/issues/45)) ([cb05a0b](https://github.com/adventdevinc/kudu/commit/cb05a0b4e9826fa27fa77ea6d934a6523e5dbb7a))
# [1.17.0](https://github.com/adventdevinc/kudu/compare/v1.16.2...v1.17.0) (2026-03-21)


### Bug Fixes

* **ci:** add notarization debug logging and build timeout ([7bd0558](https://github.com/adventdevinc/kudu/commit/7bd05588500473855bb08053047dfb69e1409df1))
* **ci:** use wingetcreate URL pipe syntax for architecture and scope overrides ([5332220](https://github.com/adventdevinc/kudu/commit/533222002a39c4a37ec9c91ae95ed792cf0aab3d))
* **security:** validate cloud remote-access boolean fields in IPC ([#31](https://github.com/adventdevinc/kudu/issues/31)) ([b5d3439](https://github.com/adventdevinc/kudu/commit/b5d3439c209cab9d172a20269e1927cef37bbd2c))


### Features

* add i18n with 30 languages ([#30](https://github.com/adventdevinc/kudu/issues/30)) ([9b2f2d0](https://github.com/adventdevinc/kudu/commit/9b2f2d09b5f0200af5cdf8bca16c852e13c585f0))
## [1.16.2](https://github.com/adventdevinc/kudu/compare/v1.16.1...v1.16.2) (2026-03-21)


### Bug Fixes

* **ci:** add winget architecture override and disable choco publish ([a84ccf7](https://github.com/adventdevinc/kudu/commit/a84ccf7aefcfc0ecdbaca1d9e8e0f9f8ffd35817))
## [1.16.1](https://github.com/adventdevinc/kudu/compare/v1.16.0...v1.16.1) (2026-03-21)


### Features

* add macOS code signing and notarization to release workflow ([#3](https://github.com/adventdevinc/kudu/issues/3)) ([b244bdd](https://github.com/adventdevinc/kudu/commit/b244bdd29c851d710b98172d1efe435ccdf55800))
# [1.16.0](https://github.com/adventdevinc/kudu/compare/v1.15.0...v1.16.0) (2026-03-20)


### Bug Fixes

* **monitor:** skip inbound connections on servers in threat monitor ([#29](https://github.com/adventdevinc/kudu/issues/29)) ([6025e67](https://github.com/adventdevinc/kudu/commit/6025e677a217eef5cd7f7980d4bef6899f0e85fc))


### Performance Improvements

* **monitor:** reduce CPU overhead by 90% ([#28](https://github.com/adventdevinc/kudu/issues/28)) ([5cc2f3d](https://github.com/adventdevinc/kudu/commit/5cc2f3dcdf5fa8316340b69b2d9ff94f242992a1))
# [1.15.0](https://github.com/adventdevinc/kudu/compare/v1.14.0...v1.15.0) (2026-03-19)


### Features

* **schedules:** dedicated Schedules page with multi-schedule support ([#26](https://github.com/adventdevinc/kudu/issues/26)) ([c19fa1f](https://github.com/adventdevinc/kudu/commit/c19fa1faf285c5a7079f110e5fff4b974754eff1))
# [1.14.0](https://github.com/adventdevinc/kudu/compare/v1.13.0...v1.14.0) (2026-03-18)


### Bug Fixes

* **browsers:** correct Helium Windows path and add missing database rules ([8e3c11b](https://github.com/adventdevinc/kudu/commit/8e3c11b7d687dd9c967dd6c4e7179064d9ed7f03))
* **cloud-agent:** add new browsers to cloud-agent browser scan list ([c4dd384](https://github.com/adventdevinc/kudu/commit/c4dd3847ab7f45733cf36745f3e1e698bc37b561))
* **darwin:** correct Helium macOS path and add missing browsers to shutdown list ([b39e9f5](https://github.com/adventdevinc/kudu/commit/b39e9f591297e37cbb5e76aee7a3beba3af069ef))
* **gaming:** correct Amazon Games log path, remove Playnite ([0832ae3](https://github.com/adventdevinc/kudu/commit/0832ae33dadadb12f1e79ff3989ca1acf469db08))
* **gaming:** remove Genshin Impact and Overwatch 2 cleaners ([3128674](https://github.com/adventdevinc/kudu/commit/31286744d4912a54d5a1e340ee5adfa4585a74db))
* **linux:** add Supermium, Helium, and Cromite to browser shutdown list ([0997d7c](https://github.com/adventdevinc/kudu/commit/0997d7c3b4e00df471bfc818bcdd548fb9edaa1a))


### Features

* **browsers:** add Thorium, Supermium, Helium, and Cromite cleaning support ([b3fea2c](https://github.com/adventdevinc/kudu/commit/b3fea2cd2861b459d497d5bda7d320b1a5aff889))
* **gaming:** add cleaners for popular games and launchers ([07e2c0a](https://github.com/adventdevinc/kudu/commit/07e2c0ab3284ba59aa7d4def06ef48e7868e355d))
* **privacy:** add AI, browser telemetry controls and expand bloatware list ([c9d3853](https://github.com/adventdevinc/kudu/commit/c9d3853a1d736cd7e76b7dbae6f32e3432011ad8))
* **privacy:** fix AI setting registry keys, skip browser checks when uninstalled ([77b8b70](https://github.com/adventdevinc/kudu/commit/77b8b70ed5504197bd624ddf827b7adeabfd9441))
# [1.13.0](https://github.com/adventdevinc/kudu/compare/v1.12.0...v1.13.0) (2026-03-18)


### Bug Fixes

* **ci:** pass single URL to match winget manifest installer count ([8a1878d](https://github.com/adventdevinc/kudu/commit/8a1878dbe9499c33fb2a709554f5b4af4e763523))
* **registry:** back up SYSTEM/HKCR hives and remove rotated log targets ([9f9bb85](https://github.com/adventdevinc/kudu/commit/9f9bb8526d79f8a85db09a9029a43f67a766a265))
* **registry:** check files not dirs in path resolution, inspect rundll32 DLLs ([1c8c107](https://github.com/adventdevinc/kudu/commit/1c8c10787cd400e450fed0894866f09707c14d0c))
* **registry:** check WOW6432Node in findMissingClsidDll, fix backup filename ([35d5c02](https://github.com/adventdevinc/kudu/commit/35d5c0245c3d328108fdbc474d8c21973cb16a7a))
* **registry:** expand env vars in uninstall scan paths via shared helper ([f5c6f9b](https://github.com/adventdevinc/kudu/commit/f5c6f9be0ba476709632e6b5c88e5f4b895e2eda))
* **registry:** handle PATH-resolved commands and evaluate COM views independently ([f981580](https://github.com/adventdevinc/kudu/commit/f98158064965b5b9ef727d2d6fc81a07fcba988a))
* **registry:** handle unquoted paths with spaces, remove unsafe singleFileTargets ([3d104b0](https://github.com/adventdevinc/kudu/commit/3d104b02d7f8af659ddc872e6c6eb868256db770))
* **registry:** match REG_EXPAND_SZ uninstall values, flag broken COM registrations, expand backups ([e3c53cd](https://github.com/adventdevinc/kudu/commit/e3c53cd9161177eb5b7b268030c5427830e71bd1))
* **registry:** only check service root keys, skip child subkeys ([edf20a1](https://github.com/adventdevinc/kudu/commit/edf20a1ef88325d699e919d68036a55a47a1920d))
* **registry:** preserve full exe paths and require broken uninstaller for orphan detection ([8498159](https://github.com/adventdevinc/kudu/commit/8498159c80ec6bbb99d5c754b2f49ab0423b9635))
* **registry:** require all COM views broken before flagging, expand service env vars ([e2bb59c](https://github.com/adventdevinc/kudu/commit/e2bb59c50a21d8e15106af628548e5cdd1096c01))
* **registry:** require missing install directory before flagging uninstall entries ([c9f8e3a](https://github.com/adventdevinc/kudu/commit/c9f8e3a7a716718f5ef786c92965fe5d5c06ba9c))
* **registry:** scan HKCU/WOW6432Node client hives, fix quoted rundll32 parsing ([5d3793f](https://github.com/adventdevinc/kudu/commit/5d3793f309c2982b96b12032a840ef6ba4d7ba56))
* **registry:** scan WOW6432Node BHO hive for 32-bit orphaned entries ([9f13381](https://github.com/adventdevinc/kudu/commit/9f13381069c1711a36604399576158b66d90ae47))
* **registry:** skip relative service paths and only check native COM view ([9808863](https://github.com/adventdevinc/kudu/commit/9808863a8a05ad4a7d545da530a77a8a82c73823))
* **registry:** split EventMessageFile on commas too and check PrimaryModule ([0bff7c1](https://github.com/adventdevinc/kudu/commit/0bff7c1bd3acbfb922df23c79d678849ebdbda90))
* **registry:** try full string as path candidate in extractExePath ([ed16a64](https://github.com/adventdevinc/kudu/commit/ed16a644c664923864b4ab795c5f7a240942e977))
* **registry:** use extractExePath() for all command-line path parsing ([289a94a](https://github.com/adventdevinc/kudu/commit/289a94ab59f69d7dd13193eb1df01f2b0e3a92e5))
* **registry:** WOW64-aware CLSID lookups, validate EventMessageFile, drop duplicate targets ([3a27695](https://github.com/adventdevinc/kudu/commit/3a27695f97507282aa0486347ff2b591c68698d9))
* **rules:** correct macOS/Linux paths and fix rules-bot template injection ([b0ccff4](https://github.com/adventdevinc/kudu/commit/b0ccff4f719c37f94d4fe6ffd393d0f49d74d505))
* **rules:** correct misleading descriptions for Google caches and Windows Update ([c0d583a](https://github.com/adventdevinc/kudu/commit/c0d583a04b22e61a5046276479e4fbd6fb23e77f))
* **rules:** remove debconf target and fix registry scan query flags ([8a3272e](https://github.com/adventdevinc/kudu/commit/8a3272e7d5b11afb92022cd5a6d7f6f84f9bd966))
* **rules:** remove live SRUM database from cleanup targets ([7c3ad2f](https://github.com/adventdevinc/kudu/commit/7c3ad2fbaf7dac0cb9b3f1e0a70e4cc2052783a3))
* **rules:** remove unsafe targets and use WOW64-aware context menu scan ([a01096d](https://github.com/adventdevinc/kudu/commit/a01096da6018ee778148906b998d7629965a0fe0))
* **startup:** add ConsoleConnect trigger for Windows Fast Startup ([bc47e06](https://github.com/adventdevinc/kudu/commit/bc47e064dbde9fd8783b601c580796baeba9cc6d))
* **startup:** revert startup state if auto-enable fails for scheduled scans ([6ac6673](https://github.com/adventdevinc/kudu/commit/6ac6673b8fbde6a6abb41bface7960742708e6a0))
* **startup:** use XML-based task creation and surface errors to UI ([28f1260](https://github.com/adventdevinc/kudu/commit/28f1260b0b4927440dafd025c207ad4d5b203127)), closes [#20](https://github.com/adventdevinc/kudu/issues/20)


### Features

* add contributor tooling for cleaner rules ([b6a6200](https://github.com/adventdevinc/kudu/commit/b6a6200f9831d33252dc1231a4167009cf776c6a))
* **rules:** add Claude, Sublime Text, Termius, Ledger Live, and more ([ef2dd70](https://github.com/adventdevinc/kudu/commit/ef2dd70f1c3699797dda88b4923aef540263ccf3))
* **rules:** add cleaning rules for browser forks, Kodi, qBittorrent, HandBrake, ccache, and Java ([33c59fb](https://github.com/adventdevinc/kudu/commit/33c59fbb4716fbdd7228392a1ae0d7f82b0a73e7))
* **rules:** expand system cleaning targets and registry orphan detection ([22f39d6](https://github.com/adventdevinc/kudu/commit/22f39d631032259f665cf5c583bc7ede3b3cdc02))
# [1.12.0](https://github.com/adventdevinc/kudu/compare/v1.11.0...v1.12.0) (2026-03-18)


### Bug Fixes

* **ci:** pass duplicate URL to resolve winget manifest multi-match error ([52fbdb5](https://github.com/adventdevinc/kudu/commit/52fbdb5983fdc02b7a1243c06523f113f92b3455))


### Features

* extract cleaner rules into community-editable JSON files ([3a2b345](https://github.com/adventdevinc/kudu/commit/3a2b345234c2e722ce3690cdf065eae844ee8d9a))
# [1.11.0](https://github.com/adventdevinc/kudu/compare/v1.10.0...v1.11.0) (2026-03-18)


### Bug Fixes

* **linux:** support libasound2 on older Ubuntu versions ([60b5c0e](https://github.com/adventdevinc/kudu/commit/60b5c0e3e6418a0a81e1971046844c188c5d5053))
* **linux:** use apt-cache policy for more reliable package detection ([2d6c503](https://github.com/adventdevinc/kudu/commit/2d6c503cb6ec392d7cb693d21b916e08c36a157b))
* **linux:** use apt-get --dry-run for package detection ([e9e28d6](https://github.com/adventdevinc/kudu/commit/e9e28d625bb50b68949e78f8e777aba0897e7058))


### Features

* add database optimizer, shortcut cleaner, and disk repair tools ([301d502](https://github.com/adventdevinc/kudu/commit/301d50229d87ef44ff3b749c980d952a89f178e3))
# [1.10.0](https://github.com/adventdevinc/kudu/compare/v1.9.0...v1.10.0) (2026-03-17)


### Bug Fixes

* **macos:** fix tray icon, dock restore, and expand malware scanner coverage ([25e74d1](https://github.com/adventdevinc/kudu/commit/25e74d10f0f0a3252eaf9265cbda2cbcc745973b))
* use path.win32.join for consistent backslash separators in win32 paths ([5d25238](https://github.com/adventdevinc/kudu/commit/5d25238644e8a449e10361aba1e18ee00174f4d0))


### Features

* enhance malware scanner with expanded detection and add tests ([4065011](https://github.com/adventdevinc/kudu/commit/406501127d73f3b7f6df64ce3b6db568cbfa7d8f))
# [1.9.0](https://github.com/adventdevinc/kudu/compare/v1.8.1...v1.9.0) (2026-03-17)


### Bug Fixes

* resolve bugs, race conditions, security issues, and dead code ([d5e3795](https://github.com/adventdevinc/kudu/commit/d5e37955cddf221e97c6db66232e41815f55ec55))


### Features

* expand cleaners with new targets, browsers, apps, and safety fixes ([497a561](https://github.com/adventdevinc/kudu/commit/497a56157c279f72edf78ee25c99b1acc2f3ea79))
## [1.8.1](https://github.com/AdventDevInc/kudu/compare/v1.8.0...v1.8.1) (2026-03-17)


### Bug Fixes

* **cloud:** improve Linux server detection and send isServer in registration ([b17c581](https://github.com/AdventDevInc/kudu/commit/b17c58188bd86a986df958515fc141234d6d0f74))
* **cloud:** skip desktop notifications in daemon/headless mode ([31ebb14](https://github.com/AdventDevInc/kudu/commit/31ebb14c154b73f55472b1c9ef490e69d74b009a))
# [1.8.0](https://github.com/AdventDevInc/kudu/compare/v1.7.0...v1.8.0) (2026-03-17)


### Bug Fixes

* **privacy:** remove unsafe sysctl hardening settings ([9f669b0](https://github.com/AdventDevInc/kudu/commit/9f669b0305e3a35ca55455e14a96d6fc198208e6))


### Features

* **cloud:** add server-only security checks to health reports ([5875d06](https://github.com/AdventDevInc/kudu/commit/5875d066a43006beec0b1465704b41cd885a910c))
# [1.7.0](https://github.com/AdventDevInc/kudu/compare/v1.6.0...v1.7.0) (2026-03-17)


### Bug Fixes

* disable macOS code signing to prevent Team ID mismatch crash ([ec923d3](https://github.com/AdventDevInc/kudu/commit/ec923d38d31b6902d4af39ffb005de6d9cc3a795))
* improve long-running stability and reduce resource usage ([d3ab953](https://github.com/AdventDevInc/kudu/commit/d3ab953eba14ed83f342d784da340a6cdbc545b6))
* use Restart=always in systemd service so daemon restarts after auto-update ([2b9eabe](https://github.com/AdventDevInc/kudu/commit/2b9eabe515981e710de362bfeb3427e5d20634a4))


### Features

* **cloud:** add SSH hardening checks to health reports ([639e4a7](https://github.com/AdventDevInc/kudu/commit/639e4a71a6e9f2933f2f1e0cfd756f49ee7018e4))
# [1.6.0](https://github.com/AdventDevInc/kudu/compare/v1.5.2...v1.6.0) (2026-03-16)


### Bug Fixes

* **darwin:** use socketfilterfw for reliable firewall status reporting ([49b198c](https://github.com/AdventDevInc/kudu/commit/49b198c70fec1a21bae88f7f3e99562480564f38))
* handle winget installer-type-changed errors correctly ([1fee6c6](https://github.com/AdventDevInc/kudu/commit/1fee6c602045396866b7041051528f4b54e2b6a5))
* **renderer:** improve privacy feedback, cross-platform updater labels, and window frame ([09eba37](https://github.com/AdventDevInc/kudu/commit/09eba37f100d10287ff1acace44da2b3682b96e1))
* suppress interactive prompts in install.sh for unattended installs ([b7b9056](https://github.com/AdventDevInc/kudu/commit/b7b9056d14aec21c7a9d572454ec1c409243ae46))


### Features

* **darwin:** add elevated execution, startup deletion, and filter Apple apps ([61bcb28](https://github.com/AdventDevInc/kudu/commit/61bcb28f9362eb2a56e16e569dfb5408c0062500))
* **dashboard:** comprehensive one-click scan with malware, privacy, and update checks ([1ee3ff1](https://github.com/AdventDevInc/kudu/commit/1ee3ff1b45de082f128718caab2bc7deee56597f))
* **malware:** add macOS malware signatures, code signing, and plist analysis ([20995fe](https://github.com/AdventDevInc/kudu/commit/20995fed324878811566c478089621dd32e8e638))
* **uninstaller:** add batch selection and multi-uninstall ([249c21d](https://github.com/AdventDevInc/kudu/commit/249c21d01883ef165df10c8df8f544b44b4903e7))
## [1.5.2](https://github.com/AdventDevInc/kudu/compare/v1.5.1...v1.5.2) (2026-03-16)


### Bug Fixes

* run winget updates sequentially to avoid lock contention ([354d4b0](https://github.com/AdventDevInc/kudu/commit/354d4b0694a9f5c7dedbf8fcd6ee63f3b2ebe994))
* set HOME=/root in systemd unit for correct config path ([3e993f6](https://github.com/AdventDevInc/kudu/commit/3e993f68510afb33faa96869428181a17e1ff197))
## [1.5.1](https://github.com/AdventDevInc/kudu/compare/v1.5.0...v1.5.1) (2026-03-15)


### Bug Fixes

* flush settings before exit in CLI config set ([a6576b4](https://github.com/AdventDevInc/kudu/commit/a6576b4698426ec6e3e5ae9fe1f17b7928c2f6bc))
* install runtime deps and use CLI for config in install.sh ([82f37d6](https://github.com/AdventDevInc/kudu/commit/82f37d61054159d18bf748a526ec61f5def5663d))
# [1.5.0](https://github.com/AdventDevInc/kudu/compare/v1.4.10...v1.5.0) (2026-03-15)


### Bug Fixes

* use large-file upload flow for VirusTotal submissions ([54f028f](https://github.com/AdventDevInc/kudu/commit/54f028fb171be2290dd37efe69902234e172caf0))


### Performance Improvements

* fix UI lag from perf monitor rendering overhead ([ea4fa1f](https://github.com/AdventDevInc/kudu/commit/ea4fa1fa26539994db7aa272b30cbebe73978093))
## [1.4.10](https://github.com/AdventDevInc/kudu/compare/v1.4.9...v1.4.10) (2026-03-15)


### Bug Fixes

* rename Chocolatey package ID to usekudu ([3904bf1](https://github.com/AdventDevInc/kudu/commit/3904bf14fb6229c9d1f511500e6fc14a6866d263))
## [1.4.9](https://github.com/AdventDevInc/kudu/compare/v1.4.8...v1.4.9) (2026-03-15)


### Features

* add Chocolatey package and automated publishing ([99d5c14](https://github.com/AdventDevInc/kudu/commit/99d5c14e704980824c47f07e2c6c1a22e50d455f))
## [1.4.8](https://github.com/AdventDevInc/kudu/compare/v1.4.7...v1.4.8) (2026-03-15)


### Bug Fixes

* pass Azure credentials as env vars for Windows code signing ([ec7c325](https://github.com/AdventDevInc/kudu/commit/ec7c3254007b7b68f0190a8b47ab384b40a3658a))
## [1.4.7](https://github.com/AdventDevInc/kudu/compare/v1.4.6...v1.4.7) (2026-03-15)


### Bug Fixes

* set shell to bash for build step to fix Windows PowerShell error ([b33dd87](https://github.com/AdventDevInc/kudu/commit/b33dd87e44a87bf4049b518b292f6d2e58c2dfac))
## [1.4.6](https://github.com/AdventDevInc/kudu/compare/v1.4.5...v1.4.6) (2026-03-15)


### Bug Fixes

* allow-no-subscriptions for Azure login in CI ([62d895f](https://github.com/AdventDevInc/kudu/commit/62d895fbd90a091dda0ecdfa1e4047529c4c0bb8))
## [1.4.5](https://github.com/AdventDevInc/kudu/compare/v1.4.4...v1.4.5) (2026-03-15)


### Bug Fixes

* move Azure signing config to CI-only to fix mac/linux validation error ([4c02e75](https://github.com/AdventDevInc/kudu/commit/4c02e75942acd1b37bd3ef5d63397965bc8ec81e))
## [1.4.4](https://github.com/AdventDevInc/kudu/compare/v1.4.3...v1.4.4) (2026-03-15)


### Features

* add Azure Trusted Signing for Windows builds, parallel malware scan, and misc improvements ([eb3f9df](https://github.com/AdventDevInc/kudu/commit/eb3f9dfee342e214e379413955ead0268b9ad5f0))
## [1.4.3](https://github.com/AdventDevInc/kudu/compare/v1.4.2...v1.4.3) (2026-03-15)


### Bug Fixes

* silently succeed for unsupported platform scan types and unwrap data envelope in payload fetch ([1a7cbb5](https://github.com/AdventDevInc/kudu/commit/1a7cbb50ce4171fb4f884848c7126a37e1789518))
## [1.4.2](https://github.com/AdventDevInc/kudu/compare/v1.4.1...v1.4.2) (2026-03-15)


### Features

* add cloud scan handlers for browser, app, gaming, recycle-bin, and uninstall-leftovers ([6cea8a6](https://github.com/AdventDevInc/kudu/commit/6cea8a63e37aced1cb09dbc0e43e03f94b3803f7))
## [1.4.1](https://github.com/AdventDevInc/kudu/compare/v1.4.0...v1.4.1) (2026-03-15)


### Bug Fixes

* race condition in payload fetch and revert incorrect success:true for unsupported platforms ([14e727b](https://github.com/AdventDevInc/kudu/commit/14e727b532ca8013d3bf0d4a9a0a45344fb57188))
# [1.4.0](https://github.com/AdventDevInc/kudu/compare/v1.3.0...v1.4.0) (2026-03-15)


### Features

* fetch full command payload when broadcast arrays are trimmed ([d530df3](https://github.com/AdventDevInc/kudu/commit/d530df34428c4c5c86389549c841a2c6728cea7b))
# [1.3.0](https://github.com/AdventDevInc/kudu/compare/v1.2.3...v1.3.0) (2026-03-15)


### Features

* require admin elevation via manifest instead of runtime re-launch ([f870da1](https://github.com/AdventDevInc/kudu/commit/f870da100ef5f22116e50bc0dfce956b0c564a9b))
## [1.2.3](https://github.com/AdventDevInc/kudu/compare/v1.2.2...v1.2.3) (2026-03-15)


### Bug Fixes

* threat monitor tab not appearing despite blacklist being loaded ([2494c7b](https://github.com/AdventDevInc/kudu/commit/2494c7be354276cbf2ce2b55cf9210887c04b4bd))
## [1.2.2](https://github.com/AdventDevInc/kudu/compare/v1.2.1...v1.2.2) (2026-03-15)


### Bug Fixes

* auto-updater crash from dynamic require of platform elevation module ([f3d9e5f](https://github.com/AdventDevInc/kudu/commit/f3d9e5fc7f93113cc0bed45aa01435ec09d92b29))
## [1.2.1](https://github.com/AdventDevInc/kudu/compare/v1.2.0...v1.2.1) (2026-03-15)


### Bug Fixes

* preserve admin elevation after auto-update and show threat monitor tab ([7378696](https://github.com/AdventDevInc/kudu/commit/73786963dd42da08bc3ec6ba898cbbf62abb71f4))
# [1.2.0](https://github.com/AdventDevInc/kudu/compare/v1.1.3...v1.2.0) (2026-03-15)


### Features

* add threat monitor, cloud agent enhancements, and IPC security hardening ([b952490](https://github.com/AdventDevInc/kudu/commit/b952490966127090ad5cdcbd6eaa3e41023a7e52))
## [1.1.3](https://github.com/AdventDevInc/kudu/compare/v1.1.2...v1.1.3) (2026-03-15)
## [1.1.2](https://github.com/AdventDevInc/kudu/compare/v1.1.1...v1.1.2) (2026-03-15)


### Bug Fixes

* AppImage hangs on headless Linux without FUSE ([8faed7f](https://github.com/AdventDevInc/kudu/commit/8faed7f0bdd98797e437344f174f4dc2cf90a468))
* install script overwrites AppImage binary via old symlink ([a71eb4e](https://github.com/AdventDevInc/kudu/commit/a71eb4ecd509d44ae4ca7ac8783da65f31029f92))
## [1.1.1](https://github.com/AdventDevInc/kudu/compare/v1.1.0...v1.1.1) (2026-03-14)


### Bug Fixes

* install script wrapper auto-injects --no-sandbox for root ([fb81a09](https://github.com/AdventDevInc/kudu/commit/fb81a09739279bceed6b081218ea3f2ae61d21f4))
# [1.1.0](https://github.com/AdventDevInc/kudu/compare/v1.0.5...v1.1.0) (2026-03-14)


### Bug Fixes

* daemon crash on headless Linux without X server ([d9fe47d](https://github.com/AdventDevInc/kudu/commit/d9fe47d7610ff14e5cfb2d019a82ce67e2ff5a57))
## [1.0.5](https://github.com/AdventDevInc/kudu/compare/v1.0.4...v1.0.5) (2026-03-14)


### Bug Fixes

* cloud agent not connecting after initial device link ([42e6e47](https://github.com/AdventDevInc/kudu/commit/42e6e47b560ecc7f0724306ba06b01a74d64dee1))
## [1.0.4](https://github.com/AdventDevInc/kudu/compare/v1.0.3...v1.0.4) (2026-03-14)


### Bug Fixes

* update repository URLs from dbfx to adventdevinc ([dede320](https://github.com/AdventDevInc/kudu/commit/dede32049b51e67bad3c6f55e38ded3eaa7322bf))
## [1.0.3](https://github.com/AdventDevInc/kudu/compare/v1.0.2...v1.0.3) (2026-03-14)


### Bug Fixes

* elevation relaunch not starting new instance on Windows ([807f50b](https://github.com/AdventDevInc/kudu/commit/807f50b1280a4540a9fd061bdc448389e72a3381))
## [1.0.2](https://github.com/AdventDevInc/kudu/compare/v1.0.1...v1.0.2) (2026-03-14)
## [1.0.1](https://github.com/AdventDevInc/kudu/compare/v1.0.0...v1.0.1) (2026-03-14)


### Bug Fixes

* make isValidAppId tests platform-aware ([1c446d1](https://github.com/AdventDevInc/kudu/commit/1c446d1fd1c64e9c746e178662e036eac9feccec))
* relaunch-as-admin not quitting when tray is active, update logo ([484f939](https://github.com/AdventDevInc/kudu/commit/484f939b1647a026d25ce5fbd4ff71bffdc60ef5))
