#!/bin/zsh
# Publishes the current version (package.json): Visual Studio Marketplace, Open VSX, and a GitHub
# release `v<version>` with the signed and notarized Cockpit Daemon app. Run it from your own
# terminal: it asks for the tokens, which never go in a file or in chat.
#
#   scripts/publish.sh                 # everything
#   SKIP_DAEMON=1 scripts/publish.sh   # only the two extension registries
#   ONLY_DAEMON=1 scripts/publish.sh   # only the daemon app and its GitHub release
#
# Needs: the .vsix of this version (npm run vsix), `gh` logged in, and for the daemon the Developer
# ID certificate in your keychain and the notarytool profile `cockpit`
# (xcrun notarytool store-credentials cockpit). See Docs/releasing.md.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
VSIX="cockpit-claude-code-daemon-$VERSION.vsix"
[[ -f "$VSIX" ]] || { echo "$VSIX is missing: run npm run vsix first" >&2; exit 1; }
echo "Publishing $VERSION"

if [[ "${ONLY_DAEMON:-0}" != "1" ]]; then
  read -s "VSCE_PAT?Marketplace token: " && export VSCE_PAT && echo
  npm run publish:marketplace

  read -s "OVSX_PAT?Open VSX token: " && export OVSX_PAT && echo
  npm run publish:openvsx
fi

if [[ "${SKIP_DAEMON:-0}" != "1" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -1)"
  [[ -n "$IDENTITY" ]] || { echo "No Developer ID Application certificate found" >&2; exit 1; }
  echo "==> building and notarizing the daemon app as: $IDENTITY"
  SIGN_IDENTITY="$IDENTITY" NOTARY_PROFILE=cockpit mac/CockpitDaemon/scripts/build-app.sh
  APP="mac/CockpitDaemon/build/Cockpit Daemon.app"
  ZIP="mac/CockpitDaemon/build/CockpitDaemon-$VERSION.zip"
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP" "$ZIP"
  gh release create "v$VERSION" "$ZIP" --title "Cockpit Daemon $VERSION (macOS menu bar app)" \
    --notes "The Cockpit Daemon menu bar app, signed and notarized. Unzip it and move it to Applications. Install, update and the extension: see the README."
fi
echo "done"
