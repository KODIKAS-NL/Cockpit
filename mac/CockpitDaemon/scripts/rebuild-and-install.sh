#!/bin/bash
# Stops the running Cockpit Daemon, rebuilds the app, installs it to /Applications and starts it.
# Running conversations stop with the daemon (they resume on the next message).
#
#   mac/CockpitDaemon/scripts/rebuild-and-install.sh
#   SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" NOTARY_PROFILE=cockpit \
#     mac/CockpitDaemon/scripts/rebuild-and-install.sh      # signed (and notarized) build
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

echo "==> building the extension and daemon.js"
(cd "$REPO" && npm run build)

echo "==> stopping Cockpit Daemon"
osascript -e 'tell application "Cockpit Daemon" to quit' 2>/dev/null || true
sleep 2
pkill -f "Cockpit Daemon.app/Contents/Resources/daemon.js" 2>/dev/null || true
pkill -f "Cockpit Daemon.app/Contents/MacOS/CockpitDaemon" 2>/dev/null || true
sleep 1

"$HERE/build-app.sh" --install

echo "==> starting Cockpit Daemon"
open -a "Cockpit Daemon"
echo "done: reload your editor windows so they attach again"
