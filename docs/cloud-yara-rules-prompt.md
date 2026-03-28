# Prompt: Build the YARA Rules API + Rule Management System

## Context

Kudu is a desktop system cleaner (Electron) with a malware scanner. The desktop client now has a WASM-based YARA engine (`libyara-wasm`) that scans files against YARA rules. **Rules are NOT shipped with the app** — they come exclusively from the Kudu cloud backend. The client caches rules to disk and periodically pulls updates.

Your job is to build:

1. **The API endpoint** (`GET /api/yara-rules`) that serves YARA rule bundles to clients
2. **The YARA rule files** themselves — translating the existing detection patterns (listed below) into proper YARA rules, organized by category
3. **A rule management system** — database schema, admin tooling, and a workflow for adding/updating/versioning rules
4. **A push mechanism** — so you can trigger immediate rule updates to connected clients via the existing Pusher WebSocket infrastructure

---

## Part 1: API Endpoint

### `GET /api/yara-rules`

**Request headers the client sends:**
```
Accept: application/json
X-Kudu-Rules-Version: 1.0.0    (the version the client currently has cached; omitted on first fetch)
```

**Response when client is up to date (version matches):**
```
HTTP/1.1 304 Not Modified
```

**Response when update is available (200 OK):**
```json
{
  "version": "1.2.0",
  "updatedAt": "2026-03-28T12:00:00Z",
  "sha256": "<hex string>",
  "rules": [
    { "filename": "miners.yar", "content": "rule CoinMiner_XMRig { ... }" },
    { "filename": "rats.yar", "content": "rule RAT_DarkComet { ... }" },
    { "filename": "ransomware.yar", "content": "..." }
  ]
}
```

**Integrity contract — the client verifies this exactly:**
```
sha256 = SHA-256( concatenation of all content fields, sorted alphabetically by filename )
```

In other words:
1. Sort the `rules` array by `filename` (lexicographic, ascending)
2. Concatenate all `content` strings (no separator)
3. SHA-256 hash that concatenation (lowercase hex)

If the hash doesn't match, the client rejects the entire bundle.

**Client-side limits (your API should stay within these):**
- Max total response body: **50 MB**
- Max individual `content` field: **1 MB**
- Max number of rules entries: **10,000**
- Each `filename` must end in `.yar`
- Each `filename` must NOT contain `/`, `\`, or `..` (path traversal protection)
- Timeout: **60 seconds**

### Push-based updates (via existing Pusher infrastructure)

When you publish new rules, also send a command to connected clients:
```json
{ "type": "update-yara-rules", "requestId": "<uuid>", "url": "https://cloud.usekudu.com/api/yara-rules" }
```

This triggers an immediate fetch+cache on the client. The client also pulls on its own every 6 hours regardless.

---

## Part 2: YARA Rules to Generate

### How a YARA rule must be structured for Kudu

Every rule MUST have these `meta` fields:
- `detectionName` (string) — the detection label shown to the user, e.g. `"CoinMiner.XMRig"`
- `severity` (string) — one of: `"critical"`, `"high"`, `"medium"`, `"low"`
- `details` (string) — human-readable description of the threat

Optional meta field:
- `filenameOnly` = `"true"` — tells the scanner this rule should only match files *outside* system directories on Windows (used for system process masquerade detection like fake svchost.exe)

Example rule:
```yara
rule CoinMiner_XMRig
{
    meta:
        detectionName = "CoinMiner.XMRig"
        severity = "critical"
        details = "XMRig cryptocurrency miner — uses CPU/GPU to mine Monero without consent"

    strings:
        $s1 = "xmrig" nocase

    condition:
        $s1
}
```

Example hash-based rule (the YARA `hash` module is available):
```yara
import "hash"

rule EICAR_TestFile
{
    meta:
        detectionName = "EICAR.TestFile"
        severity = "low"
        details = "EICAR antivirus test file — not actual malware, used to verify AV detection"

    condition:
        hash.sha256(0, filesize) == "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f"
}
```

Example filenameOnly rule:
```yara
rule Suspicious_FakeSvchost
{
    meta:
        detectionName = "Suspicious.FakeSvchost"
        severity = "high"
        details = "svchost.exe found outside System32 — likely malware disguised as system process"
        filenameOnly = "true"

    strings:
        $s1 = "svchost" nocase

    condition:
        $s1
}
```

### Organize rules into these files:

| File | Category |
|------|----------|
| `miners.yar` | Crypto miners |
| `adware.yar` | Adware and PUPs |
| `rats.yar` | Remote access trojans |
| `trojans.yar` | Banking trojans, keyloggers, general trojans |
| `stealers.yar` | Info stealers |
| `ransomware.yar` | Ransomware families and ransom notes |
| `loaders.yar` | Loaders, droppers, initial access tools |
| `hacktools.yar` | Red team / offensive tools |
| `osx_malware.yar` | macOS-specific malware |
| `linux_malware.yar` | Linux-specific malware |
| `suspicious.yar` | System process masquerades (all need `filenameOnly = "true"`) |
| `hashes.yar` | Hash-based detections (needs `import "hash"` at top) |

### Existing detections to translate

These are the hardcoded patterns currently in the Kudu client. Convert every single one into a YARA rule. Keep the exact same `detectionName`, `severity`, and `details` values:

**Crypto miners (miners.yar):**
- `/xmrig/i` → CoinMiner.XMRig, critical
- `/cpuminer/i` → CoinMiner.CPUMiner, critical
- `/\bminerd\b/i` → CoinMiner.Minerd, critical
- `/nicehashminer/i` → CoinMiner.NiceHash, high
- `/coinhive/i` → CoinMiner.CoinHive, high

**Adware/PUPs (adware.yar):**
- `/bonzi\s*buddy/i` → Adware.BonziBuddy, medium
- `/ask\s*toolbar/i` → PUP.AskToolbar, medium
- `/conduit[\s_-]?(toolbar|search|engine)/i` → PUP.Conduit, medium
- `/babylontoolbar/i` → PUP.BabylonToolbar, medium
- `/mywebsearch/i` → PUP.MyWebSearch, medium
- `/incredibar/i` → PUP.IncrediBar, medium
- `/sweetim/i` → PUP.SweetIM, medium
- `/opencandy/i` → PUP.OpenCandy, medium
- `/installcore/i` → PUP.InstallCore, medium
- `/softpulse/i` → PUP.SoftPulse, medium
- `/browsefox/i` → Adware.BrowseFox, medium
- `/crossrider/i` → Adware.CrossRider, medium
- `/wajam/i` → Adware.Wajam, high
- `/superfish/i` → Adware.Superfish, critical

**RATs (rats.yar):**
- `/darkcomet/i` → RAT.DarkComet, critical
- `/njrat/i` → RAT.njRAT, critical
- `/nanocore/i` → RAT.NanoCore, critical
- `/quasar\.?rat/i` → RAT.Quasar, critical
- `/asyncrat/i` → RAT.AsyncRAT, critical
- `/poisonivy/i` → RAT.PoisonIvy, critical
- `/\bremcos\b/i` → RAT.Remcos, critical
- `/warzone[\s_-]?rat|ave[\s_-]?maria/i` → RAT.WarzoneRAT, critical
- `/xworm/i` → RAT.XWorm, critical
- `/dcrat/i` → RAT.DCRat, critical
- `/\bnetwire\b/i` → RAT.NetWire, critical

**Trojans & Keyloggers (trojans.yar):**
- `/hawkeye[\s_.-]?(keylog|reborn|stealer|rat)/i` → Keylogger.HawkEye, critical
- `/ardamax/i` → Keylogger.Ardamax, high
- `/emotet/i` → Trojan.Emotet, critical
- `/trickbot/i` → Trojan.TrickBot, critical
- `/lokibot/i` → Trojan.LokiBot, critical
- `/formbook/i` → Trojan.FormBook, critical
- `/agenttesla/i` → Trojan.AgentTesla, critical

**Stealers (stealers.yar):**
- `/redline\s*stealer/i` → Trojan.RedLine, critical
- `/raccoon\s*stealer/i` → Trojan.Raccoon, critical
- `/vidar[\s_.-]?(stealer|malware|trojan|loader)/i` → Trojan.Vidar, critical
- `/lumma[\s_-]?stealer/i` → Trojan.LummaStealer, critical
- `/\bstealc\b/i` → Trojan.StealC, critical
- `/\brisepro\b/i` → Trojan.RisePro, critical
- `/mystic[\s_-]?stealer/i` → Trojan.MysticStealer, critical

**Ransomware (ransomware.yar):**
- `/wannacry/i` → Ransom.WannaCry, critical
- `/readme_for_decrypt/i` → Ransom.Generic, critical
- `/decrypt_instructions/i` → Ransom.Generic, critical
- `/your_files_are_encrypted/i` → Ransom.Generic, critical
- `/^how[\s_-]?to[\s_-]?decrypt\.(txt|html|hta)$/i` → Ransom.Generic, critical
- `/^restore[\s_-]?my[\s_-]?files\.(txt|html|hta)$/i` → Ransom.Generic, critical
- `/\blockbit\b/i` → Ransom.LockBit, critical
- `/blackcat[\s_-]?(ransomware|ransom|malware|locker)|\balphv\b/i` → Ransom.BlackCat, critical
- `/conti[\s_-]?(ransomware|ransom|locker|malware)/i` → Ransom.Conti, critical
- `/\brevil\b[\s_-](ransomware|ransom|locker|malware)|sodinokibi/i` → Ransom.REvil, critical
- `/ryuk[\s_-]?(ransomware|ransom|locker|malware)/i` → Ransom.Ryuk, critical
- `/blackbasta/i` → Ransom.BlackBasta, critical
- `/\bakira\b[\s_-]?(ransom|decrypt|locked)/i` → Ransom.Akira, critical
- `/royal[\s_-]?ransom/i` → Ransom.Royal, critical
- `/play[\s_-]?ransom|play[\s_-]?crypt/i` → Ransom.Play, critical

**Loaders & Hack Tools (loaders.yar + hacktools.yar):**
- `/gootloader/i` → Trojan.Gootloader, critical
- `/icedid|bokbot/i` → Trojan.IcedID, critical
- `/bumblebee[\s_-]?(loader|malware|trojan)/i` → Trojan.Bumblebee, critical
- `/pikabot/i` → Trojan.Pikabot, critical
- `/qakbot|\bqbot\b/i` → Trojan.QakBot, critical
- `/cobalt[\s_-]?strike/i` → HackTool.CobaltStrike, critical
- `/meterpreter/i` → HackTool.Meterpreter, critical
- `/sliver[\s_-]?(implant|beacon|c2)/i` → HackTool.Sliver, critical

**macOS malware (osx_malware.yar):**
- `/shlayer/i` → OSX.Shlayer, critical
- `/pirrit/i` → Adware.OSX.Pirrit, high
- `/bundlore/i` → Adware.OSX.Bundlore, medium
- `/adload/i` → Adware.OSX.Adload, high
- `/genieo/i` → Adware.OSX.Genieo, medium
- `/mackeeper/i` → PUP.OSX.MacKeeper, medium
- `/xcsset/i` → OSX.XCSSET, critical
- `/silver[\s_-]?sparrow/i` → OSX.SilverSparrow, critical
- `/atomic[\s_-]?stealer|amos[\s_-]?stealer/i` → OSX.AtomicStealer, critical
- `/\brealst\b/i` → OSX.Realst, critical
- `/cuckoo[\s_-]?stealer/i` → OSX.CuckooStealer, critical
- `/banshee[\s_-]?stealer/i` → OSX.BansheeStealer, critical
- `/cthulhu[\s_-]?stealer/i` → OSX.CthulhuStealer, critical
- `/metastealer/i` → OSX.MetaStealer, critical
- `/poseidon[\s_-]?stealer/i` → OSX.Poseidon, critical
- `/kandykorn/i` → OSX.KandyKorn, critical

**Linux malware (linux_malware.yar):**
- `/\bxorddos\b/i` → Linux.XorDDoS, critical
- `/\bperfctl\b/i` → Linux.Perfctl, critical

**Suspicious filenames (suspicious.yar) — all need `filenameOnly = "true"`:**
- svchost.exe → Suspicious.FakeSvchost, high
- csrss.exe → Suspicious.FakeCsrss, high
- lsass.exe → Suspicious.FakeLsass, high
- winlogon.exe → Suspicious.FakeWinlogon, high
- services.exe → Suspicious.FakeServices, high
- explorer.exe → Suspicious.FakeExplorer, high
- taskmgr.exe → Suspicious.FakeTaskmgr, high
- rundll32.exe → Suspicious.FakeRundll, high
- spoolsv.exe → Suspicious.FakeSpoolsv, high
- conhost.exe → Suspicious.FakeConhost, high
- dwm.exe → Suspicious.FakeDwm, high
- smss.exe → Suspicious.FakeSmss, high
- wininit.exe → Suspicious.FakeWininit, high
- dllhost.exe → Suspicious.FakeDllhost, high
- taskhost.exe → Suspicious.FakeTaskhost, high

**Hashes (hashes.yar) — needs `import "hash"` at the top:**
- EICAR test file: SHA-256 `275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f` → EICAR.TestFile, low

---

## Part 3: Rule Management System

Build a system for managing YARA rules with:

### Database schema
- **`yara_rule_files`** table — stores each `.yar` file:
  - `id`, `filename` (unique), `content` (text), `created_at`, `updated_at`
- **`yara_rule_versions`** table — tracks published bundles:
  - `id`, `version` (semver string, unique), `sha256`, `rules_count`, `published_at`, `published_by`
- **`yara_rule_version_files`** join table — links a version to its rule files (snapshot):
  - `version_id`, `rule_file_id`, `content_snapshot` (the content at time of publish)

### Admin API
- `GET /admin/yara-rules` — list all rule files with their current content
- `PUT /admin/yara-rules/:filename` — create or update a rule file
- `DELETE /admin/yara-rules/:filename` — delete a rule file
- `POST /admin/yara-rules/publish` — snapshot current rules into a new version, compute sha256, and optionally push to all connected clients
- `GET /admin/yara-rules/versions` — list all published versions
- `GET /admin/yara-rules/versions/:version` — get a specific version's full bundle

### Version workflow
1. Edit rule files via the admin API (or a UI)
2. When ready, call `POST /admin/yara-rules/publish` with `{ "version": "1.1.0", "push": true }`
3. This snapshots all current rule files, computes the sha256, stores the version
4. If `push: true`, sends the `update-yara-rules` command to all connected clients via Pusher

### Seeding
On first deploy, seed the database with all the rules listed above (translated from the regex patterns). Set the initial version to `1.0.0`.

---

## Part 4: Updating Rules Going Forward

### Adding a new threat
1. Determine the category (miner, RAT, stealer, etc.) and which `.yar` file it belongs to
2. Write a YARA rule with the required meta fields (`detectionName`, `severity`, `details`)
3. Add it to the appropriate file via the admin API
4. Publish a new version with `push: true`

### Improving detection (reducing false positives)
1. Tighten the rule's `strings` or `condition` — e.g., require multiple indicators instead of a single string match
2. Use YARA features like `filesize`, `uint16(0) == 0x5A4D` (PE check), hex patterns, regex anchors
3. Test against benign samples before publishing

### Adding hash-based detections
1. Add new hash entries to `hashes.yar` using the `hash.sha256(0, filesize)` condition
2. These provide zero false-positive detection for known-bad files
3. Good sources: VirusTotal, MalwareBazaar, abuse.ch

### Rule quality checklist
- Every rule has `detectionName`, `severity`, `details` in meta
- Rule names use `Category_ThreatName` format (e.g., `CoinMiner_XMRig`)
- Strings use `nocase` for case-insensitive matching
- Regex patterns in YARA use `/pattern/i` syntax
- `filenameOnly = "true"` is set on rules that should only apply to files outside system directories
- Rules with multiple alternatives use `any of them` in the condition
- Hash rules import `"hash"` at the top of the file (once per file, not per rule)

---

## Summary of what to build

1. **`GET /api/yara-rules`** endpoint — serves the bundle, supports `X-Kudu-Rules-Version` for 304, computes and includes `sha256`
2. **Database tables** — `yara_rule_files`, `yara_rule_versions`, `yara_rule_version_files`
3. **Admin CRUD API** — for managing rule files and publishing versions
4. **Seed data** — all rules translated from the patterns above, version 1.0.0
5. **Push integration** — on publish, optionally send `update-yara-rules` command to clients via Pusher
6. **The actual `.yar` rule content** — proper YARA syntax, organized by the file categories listed above
