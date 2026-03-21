#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────
# CLI Smoke Test
# Runs safe, read-only CLI commands against the built app and
# validates exit codes and JSON output structure.
# ───────────────────────────────────────────────────────────────
set -uo pipefail

PASS=0
FAIL=0

# On Linux CI there is no display server, and Electron's SUID sandbox
# helper is not configured.  We must pass Chromium flags directly on
# the command line — the app sets them via app.commandLine.appendSwitch
# but that runs too late for the native ozone platform selection.
if [[ "${OSTYPE:-}" == linux* ]]; then
  ELECTRON="npx electron . --no-sandbox --disable-gpu --ozone-platform=headless --cli"
else
  ELECTRON="npx electron . --cli"
fi

# ─── Helpers ──────────────────────────────────────────────────

pass() {
  echo "  PASS  $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL  $1"
  FAIL=$((FAIL + 1))
}

# Run a CLI command, capture stdout and exit code.
# Stderr is discarded — Chromium may emit noise (D-Bus, GPU warnings).
# Sets: CLI_OUTPUT, CLI_EXIT
run_cli() {
  CLI_EXIT=0
  CLI_OUTPUT=$($ELECTRON "$@" 2>/dev/null) || CLI_EXIT=$?
}

assert_exit() {
  local name="$1"
  local expected="$2"

  # Support multiple acceptable exit codes separated by |
  IFS='|' read -ra codes <<< "$expected"
  for code in "${codes[@]}"; do
    if [ "$CLI_EXIT" -eq "$code" ]; then
      pass "$name (exit=$CLI_EXIT)"
      return
    fi
  done

  fail "$name — expected exit $expected, got $CLI_EXIT"
  echo "        output: ${CLI_OUTPUT:0:300}"
}

assert_valid_json() {
  local name="$1"
  if echo "$CLI_OUTPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{JSON.parse(d);process.exit(0)})" 2>/dev/null; then
    pass "$name — valid JSON"
  else
    fail "$name — invalid JSON"
    echo "        output: ${CLI_OUTPUT:0:300}"
  fi
}

assert_contains() {
  local name="$1"
  local pattern="$2"
  if echo "$CLI_OUTPUT" | grep -qi "$pattern"; then
    pass "$name — contains '$pattern'"
  else
    fail "$name — missing '$pattern'"
    echo "        output: ${CLI_OUTPUT:0:300}"
  fi
}

assert_json_key() {
  local name="$1"
  local key="$2"
  if echo "$CLI_OUTPUT" | node -e "
    let d='';
    process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      const o=JSON.parse(d);
      process.exit(('$key' in o)?0:1)
    })
  " 2>/dev/null; then
    pass "$name — has key '$key'"
  else
    fail "$name — missing key '$key'"
  fi
}

# ─── Tests ────────────────────────────────────────────────────

echo "=== CLI Smoke Tests ==="
echo ""

# 1. --help
echo "--- --help ---"
run_cli --help
assert_exit "help exits 0" 0
assert_contains "help shows usage" "usage"

# 2. --version
echo ""
echo "--- --version ---"
run_cli --version
assert_exit "version exits 0" 0
assert_contains "version output" "Kudu v"

# 3. Unknown command → exit 6
echo ""
echo "--- unknown command ---"
run_cli --json bogus-command-12345
assert_exit "unknown command exits 6" 6
assert_valid_json "unknown command JSON"
assert_json_key "unknown command error key" "error"

# 4. Mutually exclusive flags → exit 2
echo ""
echo "--- mutually exclusive flags ---"
run_cli --verbose --quiet --json scan
assert_exit "verbose+quiet exits 2" 2

# 5. history list --json (read-only, returns empty array or entries)
echo ""
echo "--- history list --json ---"
run_cli history --json list
assert_exit "history list exits 0" 0
assert_valid_json "history list JSON"

# 6. config get --json (read-only, returns settings object)
echo ""
echo "--- config get --json ---"
run_cli config --json get
assert_exit "config get exits 0" 0
assert_valid_json "config get JSON"

# 7. metrics --json (read-only, returns metrics array)
echo ""
echo "--- metrics --json ---"
run_cli metrics --json
assert_exit "metrics exits 0" 0
assert_valid_json "metrics JSON"

# 8. scan --json (read-only, may find items or not — exit 0 or 5)
# -q suppresses progress text that would otherwise pollute JSON output
echo ""
echo "--- scan --json ---"
run_cli scan --json -q --all
assert_exit "scan exits 0 or 5" "0|5"
assert_valid_json "scan JSON"
assert_json_key "scan has 'scan' key" "scan"

# ─── Summary ──────────────────────────────────────────────────

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
