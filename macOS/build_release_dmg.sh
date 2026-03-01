#!/usr/bin/env bash
set -euo pipefail

# Configuration
APP_NAME="OmniKeyAI"
BUNDLE_ID="com.omnikeyai"          # Change if you prefer a different bundle identifier
TEAM_ID="VVJ24MPJZ6"               # Your Apple Developer Team ID
DEVELOPER_NAME="Gurinder Singh"
DEVELOPER_ID_CERT="Developer ID Application: ${DEVELOPER_NAME} (${TEAM_ID})"
NOTARY_PROFILE="omnikey-notary"    # Notarytool keychain profile name

info() { echo "[INFO] $*"; }
err()  { echo "[ERROR] $*" >&2; }

# Derived paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/.build/release"
APP_BUNDLE="${SCRIPT_DIR}/${APP_NAME}.app"
DMG_PATH="${SCRIPT_DIR}/${APP_NAME}.dmg"
APP_ZIP="${SCRIPT_DIR}/${APP_NAME}.zip"

info "Working directory (script dir): ${SCRIPT_DIR}"

# --- Locate Assets.xcassets robustly (do NOT assume it's next to the script) ---
ASSET_CATALOG=""
CANDIDATES=(
  "${SCRIPT_DIR}/Assets.xcassets"
  "${SCRIPT_DIR}/../Assets.xcassets"
  "${SCRIPT_DIR}/Sources/Assets.xcassets"
  "${SCRIPT_DIR}/Sources/${APP_NAME}/Assets.xcassets"
  "${SCRIPT_DIR}/Resources/Assets.xcassets"
)

for p in "${CANDIDATES[@]}"; do
  if [[ -d "$p" ]]; then
    ASSET_CATALOG="$p"
    break
  fi
done

if [[ -z "${ASSET_CATALOG}" ]]; then
  err "Could not find Assets.xcassets near script location."
  err "Tried:"
  for p in "${CANDIDATES[@]}"; do echo "  - $p" >&2; done
  err "Hint: from your repo root run: find . -name Assets.xcassets -maxdepth 6"
  exit 1
fi

info "Using asset catalog at: ${ASSET_CATALOG}"

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

# 3. Compile Assets.xcassets into the app bundle (produces Assets.car)
info "Compiling asset catalog (AppIcon + StatusItemIcon) via actool..."
PARTIAL_PLIST="${BUILD_DIR}/assetcatalog.plist"
mkdir -p "${BUILD_DIR}"

xcrun actool \
  --compile "${APP_BUNDLE}/Contents/Resources" \
  --platform macosx \
  --target-device mac \
  --minimum-deployment-target 13.0 \
  --app-icon AppIcon \
  --product-type com.apple.product-type.application \
  --output-partial-info-plist "${PARTIAL_PLIST}" \
  --errors --warnings --notices \
  "${ASSET_CATALOG}"

# Fail loudly if icon compilation didn't actually output the compiled catalog
if [[ ! -f "${APP_BUNDLE}/Contents/Resources/Assets.car" ]]; then
  err "actool did not produce Assets.car in ${APP_BUNDLE}/Contents/Resources."
  err "This usually means:"
  err "  - AppIcon is missing (no AppIcon.appiconset), OR"
  err "  - AppIcon is not a macOS icon set (missing idiom: mac), OR"
  err "  - actool failed to compile resources as expected."
  err "Resources contents:"
  ls -la "${APP_BUNDLE}/Contents/Resources" || true
  exit 1
fi

# 4. Generate Info.plist
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

    <!-- Use asset-catalog icon name (expects Assets.car in Contents/Resources) -->
    <key>CFBundleIconName</key>
    <string>AppIcon</string>

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

# 5. Copy binary into bundle
info "Copying binary into app bundle..."
cp "${BINARY_PATH}" "${APP_BUNDLE}/Contents/MacOS/${APP_NAME}"
chmod +x "${APP_BUNDLE}/Contents/MacOS/${APP_NAME}"

# 5a. Copy MenuBarIcon.png into Resources so the status item can load it
MENU_BAR_ICON_SRC="${SCRIPT_DIR}/Sources/assets/MenuBarIcon.png"
if [[ -f "${MENU_BAR_ICON_SRC}" ]]; then
  info "Copying MenuBarIcon.png into app Resources..."
  cp "${MENU_BAR_ICON_SRC}" "${APP_BUNDLE}/Contents/Resources/MenuBarIcon.png"
else
  info "MenuBarIcon.png not found at ${MENU_BAR_ICON_SRC}; status bar icon will fall back to text."
fi

# 6. Codesign the app bundle
info "Code signing app bundle with Developer ID certificate..."
codesign --deep --force --options runtime \
  --sign "${DEVELOPER_ID_CERT}" \
  "${APP_BUNDLE}"

# 7. Verify code signature
info "Verifying code signature..."
codesign --verify --deep --strict --verbose=2 "${APP_BUNDLE}"
spctl --assess --type execute --verbose "${APP_BUNDLE}" || true

# 8. Notarize the app with notarytool (submit as .zip)
info "Preparing ZIP for notarization..."
rm -f "${APP_ZIP}"
ditto -c -k --keepParent "${APP_BUNDLE}" "${APP_ZIP}"

info "Submitting app ZIP for notarization (profile: ${NOTARY_PROFILE})..."
xcrun notarytool submit "${APP_ZIP}" \
  --keychain-profile "${NOTARY_PROFILE}" \
  --wait

# 9. Staple the notarization ticket
info "Stapling notarization ticket to app bundle..."
xcrun stapler staple "${APP_BUNDLE}"

# 10. Create the DMG
info "Creating DMG at ${DMG_PATH}..."
rm -f "${DMG_PATH}"
hdiutil create -volname "${APP_NAME}" \
  -srcfolder "${APP_BUNDLE}" \
  -ov -format UDZO "${DMG_PATH}"

info "Done. DMG created at: ${DMG_PATH}"