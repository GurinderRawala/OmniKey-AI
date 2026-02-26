#!/usr/bin/env bash
set -euo pipefail

# Configuration
APP_NAME="OmniKeyAI"
BUNDLE_ID="com.omnikeyai"   # Change if you prefer a different bundle identifier
TEAM_ID="VVJ24MPJZ6"     # Your Apple Developer Team ID
DEVELOPER_NAME="Gurinder Singh"
DEVELOPER_ID_CERT="Developer ID Application: ${DEVELOPER_NAME} (${TEAM_ID})"
NOTARY_PROFILE="omnikey-notary"        # Notarytool keychain profile name

# Derived paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/.build/release"
APP_BUNDLE="${SCRIPT_DIR}/${APP_NAME}.app"
DMG_PATH="${SCRIPT_DIR}/${APP_NAME}.dmg"
APP_ZIP="${SCRIPT_DIR}/${APP_NAME}.zip"

info() { echo "[INFO] $*"; }
err() { echo "[ERROR] $*" >&2; }

info "Working directory: ${SCRIPT_DIR}"

# 1. Build release binary with SwiftPM
info "Building release binary with SwiftPM..."
cd "${SCRIPT_DIR}"
swift build -c release

BINARY_PATH="${BUILD_DIR}/${APP_NAME}"
if [[ ! -f "${BINARY_PATH}" ]]; then
  err "Expected binary not found at ${BINARY_PATH}"
  exit 1
fi

# 2. Create .app bundle structure
info "Preparing .app bundle..."
rm -rf "${APP_BUNDLE}"
mkdir -p "${APP_BUNDLE}/Contents/MacOS"
mkdir -p "${APP_BUNDLE}/Contents/Resources"

# 3. Generate Info.plist
INFO_PLIST="${APP_BUNDLE}/Contents/Info.plist"
cat > "${INFO_PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <!-- Run as a UIElement (menu bar style, no Dock icon). Remove if you want Dock icon. -->
    <key>LSUIElement</key>
    <true/>
    <!-- Required for global keyboard monitoring / shortcuts -->
    <key>NSInputMonitoringUsageDescription</key>
    <string>OmniKeyAI needs access to your keyboard input to trigger global shortcuts.</string>
</dict>
</plist>
EOF

# 4. Copy binary into bundle
info "Copying binary into app bundle..."
cp "${BINARY_PATH}" "${APP_BUNDLE}/Contents/MacOS/${APP_NAME}"
chmod +x "${APP_BUNDLE}/Contents/MacOS/${APP_NAME}"

# 5. Codesign the app bundle
info "Code signing app bundle with Developer ID certificate..."
codesign --deep --force --options runtime \
  --sign "${DEVELOPER_ID_CERT}" \
  "${APP_BUNDLE}"

# 6. Verify code signature
info "Verifying code signature..."
codesign --verify --deep --strict --verbose=2 "${APP_BUNDLE}"
spctl --assess --type execute --verbose "${APP_BUNDLE}" || true

# 7. Notarize the app with notarytool (submit as .zip)
info "Preparing ZIP for notarization..."
rm -f "${APP_ZIP}"
ditto -c -k --keepParent "${APP_BUNDLE}" "${APP_ZIP}"

info "Submitting app ZIP for notarization (profile: ${NOTARY_PROFILE})..."
xcrun notarytool submit "${APP_ZIP}" \
  --keychain-profile "${NOTARY_PROFILE}" \
  --wait

# 8. Staple the notarization ticket
info "Stapling notarization ticket to app bundle..."
xcrun stapler staple "${APP_BUNDLE}"

# 9. Create the DMG
info "Creating DMG at ${DMG_PATH}..."
rm -f "${DMG_PATH}"
hdiutil create -volname "${APP_NAME}" \
  -srcfolder "${APP_BUNDLE}" \
  -ov -format UDZO "${DMG_PATH}"

info "Done. DMG created at: ${DMG_PATH}"
