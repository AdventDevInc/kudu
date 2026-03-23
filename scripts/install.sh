#!/usr/bin/env bash
# Kudu Linux installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/adventdevinc/kudu/main/scripts/install.sh | bash
#   curl -fsSL ... | bash -s -- --api-key YOUR_KEY
#   curl -fsSL ... | bash -s -- --no-daemon   (install only, don't enable daemon)
#   curl -fsSL ... | bash -s -- --no-boot     (install only, don't enable boot service)

set -euo pipefail

REPO="adventdevinc/kudu"
INSTALL_DIR="/opt/kudu"
BIN_LINK="/usr/local/bin/kudu"
SERVICE_NAME="kudu-daemon"

API_KEY=""
NO_DAEMON=false
NO_BOOT=false
INSTALL_USER="${SUDO_USER:-$USER}"
INSTALL_HOME=$(eval echo "~${INSTALL_USER}")

# ── Parse arguments ──────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-key)    API_KEY="$2";    shift 2 ;;
    --no-daemon)  NO_DAEMON=true;  shift ;;
    --no-boot)    NO_BOOT=true;    shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────
log()  { echo -e "\033[1;34m==>\033[0m $*"; }
ok()   { echo -e "\033[1;32m==>\033[0m $*"; }
err()  { echo -e "\033[1;31m==>\033[0m $*" >&2; }

require() {
  if ! command -v "$1" &>/dev/null; then
    err "Required command not found: $1"
    exit 1
  fi
}

# ── Preflight ────────────────────────────────────────────────────
require curl
require jq

if [[ "$(uname -s)" != "Linux" ]]; then
  err "This installer is for Linux only."
  exit 1
fi

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH_LABEL="x86_64" ;;
  *)       err "Unsupported architecture: $ARCH (only x86_64 is supported)"; exit 1 ;;
esac

if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (use sudo)."
  exit 1
fi

# ── Install runtime dependencies ─────────────────────────────────
log "Installing runtime dependencies..."
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1
apt-get update -qq
# libasound2 was renamed to libasound2t64 in Ubuntu 24.04+
if dpkg -s libasound2t64 &>/dev/null || apt-get install -y -qq --dry-run libasound2t64 &>/dev/null; then
  ALSA_PKG=libasound2t64
else
  ALSA_PKG=libasound2
fi

apt-get install -y -qq \
  libfuse2 \
  libgtk-3-0 \
  libatk1.0-0 \
  libnss3 \
  libxss1 \
  "$ALSA_PKG" \
  libgbm1 \
  > /dev/null
ok "Dependencies installed."

# ── Fetch latest release ────────────────────────────────────────
log "Finding latest Kudu release..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")
VERSION=$(echo "$RELEASE_JSON" | jq -r '.tag_name')
ASSET_NAME="Kudu-${VERSION#v}-${ARCH_LABEL}.AppImage"
DOWNLOAD_URL=$(echo "$RELEASE_JSON" | jq -r \
  --arg name "$ASSET_NAME" \
  '.assets[] | select(.name == $name) | .browser_download_url')

if [[ -z "$DOWNLOAD_URL" || "$DOWNLOAD_URL" == "null" ]]; then
  err "Could not find AppImage asset: $ASSET_NAME"
  err "Available assets:"
  echo "$RELEASE_JSON" | jq -r '.assets[].name' >&2
  exit 1
fi

log "Latest version: $VERSION"
log "Downloading $ASSET_NAME..."

# ── Download and install ─────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
APPIMAGE_PATH="${INSTALL_DIR}/Kudu.AppImage"

# Download to temp file first, then move atomically
TMP_FILE=$(mktemp "${INSTALL_DIR}/.kudu-download.XXXXXX")
trap 'rm -f "$TMP_FILE"' EXIT

curl -fSL --progress-bar "$DOWNLOAD_URL" -o "$TMP_FILE"
chmod +x "$TMP_FILE"
mv -f "$TMP_FILE" "$APPIMAGE_PATH"
trap - EXIT

# Remove any old symlink first — if BIN_LINK is a symlink pointing at
# APPIMAGE_PATH, writing through it would overwrite the real binary.
rm -f "$BIN_LINK"

# Create wrapper script in PATH (instead of a plain symlink) so that
# --no-sandbox and --ozone-platform=headless are always injected for
# daemon/CLI usage.  Chromium checks the real argv for --no-sandbox
# before Electron's app.commandLine.appendSwitch runs, so the flag
# must be on the actual command line.
cat > "$BIN_LINK" <<'WRAPPER'
#!/usr/bin/env bash
EXTRA_ARGS=()
# Always add --no-sandbox when running as root (required by Chromium)
if [[ $EUID -eq 0 ]]; then
  EXTRA_ARGS+=(--no-sandbox)
fi
# Add headless ozone platform for daemon/CLI (no display needed)
for arg in "$@"; do
  case "$arg" in
    --daemon|--cli)
      EXTRA_ARGS+=(--ozone-platform=headless)
      break
      ;;
  esac
done
# Run without FUSE mount (avoids hang on servers without libfuse)
export APPIMAGE_EXTRACT_AND_RUN=1
exec /opt/kudu/Kudu.AppImage "${EXTRA_ARGS[@]}" "$@"
WRAPPER
chmod +x "$BIN_LINK"

ok "Installed Kudu $VERSION to $APPIMAGE_PATH"

# ── Configure API key / server URL ───────────────────────────────
if [[ -n "$API_KEY" ]]; then
  log "Saving API key..."
  APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGE_PATH" --no-sandbox --ozone-platform=headless \
    --cli config set cloud.apiKey "$API_KEY"
  ok "API key saved."
fi

# ── Systemd service for boot ─────────────────────────────────────
if [[ "$NO_BOOT" == false ]] && command -v systemctl &>/dev/null; then
  log "Creating systemd service..."

  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Kudu Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${APPIMAGE_PATH} --no-sandbox --ozone-platform=headless --daemon
Restart=always
RestartSec=10
Environment=HOME=/root
Environment=APPIMAGE=${APPIMAGE_PATH}
Environment=APPIMAGE_EXTRACT_AND_RUN=1

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  ok "Systemd service created and enabled for boot."

  if [[ "$NO_DAEMON" == false && -n "$API_KEY" ]]; then
    log "Starting daemon..."
    systemctl start "$SERVICE_NAME"
    ok "Daemon started."
  fi
else
  if [[ "$NO_BOOT" == true ]]; then
    log "Skipping boot service (--no-boot)."
  else
    log "systemd not found — skipping boot service."
    log "You can run the daemon manually: kudu --no-sandbox --daemon"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────
echo ""
ok "Kudu $VERSION installation complete!"
echo ""
echo "  Binary:   $APPIMAGE_PATH"
echo "  Symlink:  $BIN_LINK"
[[ "$NO_BOOT" == false ]] && command -v systemctl &>/dev/null && \
echo "  Service:  systemctl status $SERVICE_NAME"
echo ""
echo "  Run GUI:        kudu --no-sandbox"
echo "  Run CLI:        kudu --no-sandbox --cli"
echo "  Run daemon:     kudu --no-sandbox --daemon"
echo "  Check status:   systemctl status $SERVICE_NAME"
echo "  View logs:      journalctl -u $SERVICE_NAME -f"
echo ""
