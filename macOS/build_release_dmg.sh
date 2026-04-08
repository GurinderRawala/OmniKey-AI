#!/usr/bin/env bash
set -euo pipefail

# Configuration
APP_NAME="OmniKeyAI"
BUNDLE_ID="com.omnikeyai"          # Change if you prefer a different bundle identifier
TEAM_ID="VVJ24MPJZ6"               # Your Apple Developer Team ID
DEVELOPER_NAME="Gurinder Singh"
DEVELOPER_ID_CERT="Developer ID Application: ${DEVELOPER_NAME} (${TEAM_ID})"
NOTARY_PROFILE="omnikey-notary"    # Notarytool keychain profile name

# Backend base URL for the packaged app.
#
# Order of precedence at runtime (see APIClient):
#   1. Environment variable OMNIKEY_BACKEND_URL
#   2. Info.plist key OMNIKEY_BACKEND_URL (set here)
#   3. Fallback to http://localhost:7071
#
# You can override this when building, e.g.:
#   OMNIKEY_BACKEND_URL="https://my-custom-backend" ./build_release_dmg.sh
#
# NOTE: We intentionally do not hard-code the SaaS URL here.
#       The value is taken from your local OMNIKEY_BACKEND_URL
#       environment variable, falling back to localhost for dev.
BACKEND_BASE_URL="${OMNIKEY_BACKEND_URL:-http://localhost:7071}"

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
    <string>21</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.20</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>

    <!-- Backend base URL used by APIClient (can be overridden by env OMNIKEY_BACKEND_URL) -->
    <key>OMNIKEY_BACKEND_URL</key>
    <string>${BACKEND_BASE_URL}</string>

    <!-- Sparkle update feed URL. The backend should expose an appcast
      at /macos/appcast which in turn points its enclosure URL to
      the existing /macos/download DMG endpoint. -->
    <key>SUFeedURL</key>
    <string>${BACKEND_BASE_URL}/macos/appcast</string>

    <!-- Enable automatic periodic update checks -->
    <key>SUEnableAutomaticChecks</key>
    <true/>

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

# 5a. Embed Sparkle.framework used by the binary
# SwiftPM links against Sparkle as a dynamic framework located in
# ${BUILD_DIR}/Sparkle.framework. At runtime, the loader uses an
# rpath of @loader_path, so we need Sparkle.framework next to the
# executable (Contents/MacOS).
SPARKLE_FRAMEWORK_SOURCE="${BUILD_DIR}/Sparkle.framework"
if [[ -d "${SPARKLE_FRAMEWORK_SOURCE}" ]]; then
  info "Embedding Sparkle.framework into app bundle..."
  cp -R "${SPARKLE_FRAMEWORK_SOURCE}" "${APP_BUNDLE}/Contents/MacOS/"
else
  err "Sparkle.framework not found at ${SPARKLE_FRAMEWORK_SOURCE}"
  err "Did SwiftPM finish fetching/building the Sparkle package?"
  exit 1
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

if [[ -n "${NOTARY_SUBMISSION_ID:-}" ]]; then
  SUBMISSION_ID="${NOTARY_SUBMISSION_ID}"
  info "Reusing existing notarization submission ID: ${SUBMISSION_ID}"
else
  info "Submitting app ZIP for notarization (profile: ${NOTARY_PROFILE})..."
  SUBMIT_JSON="$(xcrun notarytool submit "${APP_ZIP}" \
    --keychain-profile "${NOTARY_PROFILE}" \
    --output-format json)"

  SUBMISSION_ID="$(echo "${SUBMIT_JSON}" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  if [[ -z "${SUBMISSION_ID}" ]]; then
    err "Could not parse notarization Submission ID from notarytool output."
    err "Raw output: ${SUBMIT_JSON}"
    exit 1
  fi
fi

info "Notarization submission ID: ${SUBMISSION_ID}"

# Poll notary status with a timeout to avoid indefinite waits.
NOTARY_TIMEOUT_SECONDS="${NOTARY_TIMEOUT_SECONDS:-1800}"
NOTARY_POLL_INTERVAL_SECONDS="${NOTARY_POLL_INTERVAL_SECONDS:-15}"
START_TIME="$(date +%s)"
FINAL_STATUS=""

while true; do
  INFO_JSON="$(xcrun notarytool info "${SUBMISSION_ID}" \
    --keychain-profile "${NOTARY_PROFILE}" \
    --output-format json)"

  STATUS="$(echo "${INFO_JSON}" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  NOW="$(date +%s)"
  ELAPSED="$((NOW - START_TIME))"

  if [[ -n "${STATUS}" ]]; then
    info "Notarization status: ${STATUS} (elapsed ${ELAPSED}s)"
  else
    info "Notarization status unavailable yet (elapsed ${ELAPSED}s)"
  fi

  case "${STATUS}" in
    Accepted)
      FINAL_STATUS="Accepted"
      break
      ;;
    Invalid|Rejected)
      FINAL_STATUS="${STATUS}"
      break
      ;;
  esac

  if (( ELAPSED >= NOTARY_TIMEOUT_SECONDS )); then
    err "Notarization timed out after ${NOTARY_TIMEOUT_SECONDS}s."
    err "Check status manually with: xcrun notarytool info ${SUBMISSION_ID} --keychain-profile ${NOTARY_PROFILE}"
    err "Fetch detailed log with: xcrun notarytool log ${SUBMISSION_ID} --keychain-profile ${NOTARY_PROFILE}"
    exit 1
  fi

  sleep "${NOTARY_POLL_INTERVAL_SECONDS}"
done

if [[ "${FINAL_STATUS}" != "Accepted" ]]; then
  err "Notarization failed with status: ${FINAL_STATUS}"
  err "Fetching notarization log..."
  xcrun notarytool log "${SUBMISSION_ID}" --keychain-profile "${NOTARY_PROFILE}" || true
  exit 1
fi

info "Notarization accepted."

# 9. Staple the notarization ticket
info "Stapling notarization ticket to app bundle..."
xcrun stapler staple "${APP_BUNDLE}"

# 10. Create DMG with drag-to-Applications layout
info "Preparing DMG staging folder..."
STAGE_DIR="${SCRIPT_DIR}/dmg-root"
rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}"
cp -R "${APP_BUNDLE}" "${STAGE_DIR}/OmniKeyAI.app"
ln -s /Applications "${STAGE_DIR}/Applications"

info "Creating styled DMG..."
rm -f "${DMG_PATH}"

sudo create-dmg \
  --volname "${APP_NAME}" \
  --volicon "${APP_BUNDLE}/Contents/Resources/AppIcon.icns" \
  --window-size 600 400 \
  --icon-size 128 \
  --icon "OmniKeyAI.app" 150 200 \
  --icon "Applications" 450 200 \
  "${DMG_PATH}" \
  "${STAGE_DIR}"

info "Done. DMG created at: ${DMG_PATH}"