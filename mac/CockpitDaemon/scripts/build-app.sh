#!/bin/bash
# Builds "Cockpit Daemon.app": the Swift menu bar app with dist/daemon.js bundled inside.
#
#   mac/CockpitDaemon/scripts/build-app.sh             # build into mac/CockpitDaemon/build/
#   mac/CockpitDaemon/scripts/build-app.sh --install   # …and copy to /Applications
#
# Needs: Xcode or the Command Line Tools (swift), and the extension's dependencies
# (npm ci at the repo root) when dist/daemon.js has not been built yet.
# UNIVERSAL=1 builds for both Apple silicon and Intel (needs full Xcode).
#
# Signing (optional; ad hoc by default, which is enough on the Mac that builds it):
#   SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"   sign with your certificate
#   NOTARY_PROFILE=cockpit   also notarize and staple (needs SIGN_IDENTITY; create the profile
#                            once with: xcrun notarytool store-credentials cockpit)
# List your certificates with: security find-identity -v -p codesigning
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
APP_NAME="Cockpit Daemon"
BUNDLE_ID="local.cockpit.daemon-app"
OUT="$HERE/build"
APP="$OUT/$APP_NAME.app"

install=0
for arg in "$@"; do
  case "$arg" in
    --install) install=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# 1. The daemon itself, built by the extension's normal build.
if [[ ! -f "$REPO/dist/daemon.js" ]]; then
  echo "==> dist/daemon.js missing: building the extension"
  (cd "$REPO" && npm run build)
fi

# 2. The Swift app.
echo "==> swift build"
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  arch_flags=(--arch arm64 --arch x86_64)
else
  arch_flags=()
fi
swift build -c release --package-path "$HERE" "${arch_flags[@]+"${arch_flags[@]}"}"
BIN_DIR="$(swift build -c release --package-path "$HERE" "${arch_flags[@]+"${arch_flags[@]}"}" --show-bin-path)"

# 3. The bundle.
echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/CockpitDaemon" "$APP/Contents/MacOS/CockpitDaemon"
cp "$REPO/dist/daemon.js" "$APP/Contents/Resources/daemon.js"

VERSION="$(node -p "require('$REPO/package.json').version" 2>/dev/null || echo 1.0.0)"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>CockpitDaemon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <!-- Menu bar app: no Dock icon; the window opens from the menu bar icon. -->
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# 4. Signature. Ad hoc runs on this Mac; a Developer ID signature also keeps macOS
#    permission grants across rebuilds and, notarized, runs on other Macs.
identity="${SIGN_IDENTITY:--}"
if [[ "$identity" == "-" ]]; then
  echo "==> signing (ad hoc)"
  codesign --force --sign - --timestamp=none "$APP"
else
  echo "==> signing as: $identity"
  # Hardened runtime: required for notarization. The app needs no entitlements: it is not
  # sandboxed, and the daemon runs in its own `node` process.
  codesign --force --options runtime --timestamp --sign "$identity" "$APP"
fi
codesign --verify --strict --verbose=1 "$APP"

if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  if [[ "$identity" == "-" ]]; then
    echo "NOTARY_PROFILE needs SIGN_IDENTITY (a Developer ID Application certificate)." >&2
    exit 1
  fi
  echo "==> notarizing (a few minutes)"
  zip="$OUT/$APP_NAME-notarize.zip"
  rm -f "$zip"
  ditto -c -k --keepParent "$APP" "$zip"
  xcrun notarytool submit "$zip" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f "$zip"
  spctl --assess --type execute --verbose "$APP"
fi

echo "==> built $APP"

if [[ "$install" == "1" ]]; then
  dest="/Applications/$APP_NAME.app"
  if pgrep -f "$dest/Contents/MacOS/CockpitDaemon" >/dev/null; then
    echo "Quit the running $APP_NAME first (it stops the daemon), then run --install again." >&2
    exit 1
  fi
  rm -rf "$dest"
  cp -R "$APP" "$dest"
  echo "==> installed $dest"
fi
