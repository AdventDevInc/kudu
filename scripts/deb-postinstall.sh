#!/usr/bin/env bash
# Post-install script for the Kudu .deb package.
# Sets the SUID bit on Chromium's sandbox helper so Electron can create
# sandboxed renderer processes without requiring unprivileged user namespaces
# (which some distros like Linux Mint disable by default).

SANDBOX="/opt/Kudu/chrome-sandbox"

if [ -f "$SANDBOX" ]; then
  chown root:root "$SANDBOX"
  chmod 4755 "$SANDBOX"
fi
