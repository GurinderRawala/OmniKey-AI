#!/usr/bin/env bash
# scripts/release.sh — Bump version and build the macOS + Windows desktop apps.
#
# Runs on macOS from the repo root. The macOS build produces a signed &
# notarised DMG via macOS/build_release_dmg.sh; the Windows build cross-
# compiles a self-contained win-x64 single-file ZIP via
# windows/build_release_zip.ps1 (requires pwsh + dotnet SDK 10).
#
# The two desktop apps carry independent version numbers today:
#   • macOS  – Info.plist CFBundleShortVersionString / CFBundleVersion
#              baked into macOS/build_release_dmg.sh
#   • Windows – <Version>/<AssemblyVersion>/<FileVersion> in
#              windows/OmniKey.Windows.csproj
#
# You can bump both together (--bump patch|minor|major) or set them
# individually (--macos X.Y.Z --windows X.Y[.Z]). When both flags are
# combined the explicit values win.
#
# Usage:
#   scripts/release.sh --bump patch              # bumps both
#   scripts/release.sh --bump minor --skip-windows
#   scripts/release.sh --macos 1.0.44 --windows 1.16
#   scripts/release.sh --dry-run --bump patch    # show planned changes only
#   scripts/release.sh --no-bump                 # rebuild current versions
#
# Options:
#   --bump {patch|minor|major}  Auto-bump both apps' versions.
#   --macos <version>           Explicit macOS marketing version (X.Y.Z).
#   --windows <version>         Explicit Windows version (X.Y or X.Y.Z).
#   --no-bump                   Build without changing versions.
#   --skip-macos                Skip the macOS build.
#   --skip-windows              Skip the Windows build.
#   --dry-run                   Print planned changes without editing/building.
#   --no-commit                 Don't stage/commit the version bumps.
#   -h, --help                  Show this help.

set -euo pipefail

# ── Locate repo root regardless of where the caller invoked us from ────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

MACOS_BUILD_SCRIPT="${REPO_ROOT}/macOS/build_release_dmg.sh"
WINDOWS_BUILD_SCRIPT="${REPO_ROOT}/windows/build_release_zip.ps1"
WINDOWS_CSPROJ="${REPO_ROOT}/windows/OmniKey.Windows.csproj"

# ── Pretty logging ─────────────────────────────────────────────────────────
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
YLW=$'\033[33m'; BLU=$'\033[34m'; RST=$'\033[0m'
step() { printf "%s▶%s %s%s%s\n" "$BLU" "$RST" "$BOLD" "$*" "$RST"; }
info() { printf "%s  %s%s\n" "$DIM" "$*" "$RST"; }
ok()   { printf "%s✓%s %s\n" "$GRN" "$RST" "$*"; }
warn() { printf "%s!%s %s\n" "$YLW" "$RST" "$*"; }
die()  { printf "%s✗%s %s\n" "$RED" "$RST" "$*" >&2; exit 1; }

# ── Args ───────────────────────────────────────────────────────────────────
BUMP=""
MACOS_VERSION=""
WINDOWS_VERSION=""
NO_BUMP=0
SKIP_MACOS=0
SKIP_WINDOWS=0
DRY_RUN=0
COMMIT=1

usage() { sed -n '2,32p' "$0"; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --bump)         BUMP="${2:-}";           shift 2;;
        --macos)        MACOS_VERSION="${2:-}";  shift 2;;
        --windows)      WINDOWS_VERSION="${2:-}"; shift 2;;
        --no-bump)      NO_BUMP=1;               shift;;
        --skip-macos)   SKIP_MACOS=1;            shift;;
        --skip-windows) SKIP_WINDOWS=1;          shift;;
        --dry-run)      DRY_RUN=1;               shift;;
        --no-commit)    COMMIT=0;                shift;;
        -h|--help)      usage 0;;
        *)              die "Unknown argument: $1 (see --help)";;
    esac
done

if [[ -n "$BUMP" && "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
    die "--bump must be one of: patch, minor, major (got: $BUMP)"
fi

# ── Precondition checks ────────────────────────────────────────────────────
[[ -f "$MACOS_BUILD_SCRIPT"  ]] || die "Missing $MACOS_BUILD_SCRIPT"
[[ -f "$WINDOWS_BUILD_SCRIPT" ]] || die "Missing $WINDOWS_BUILD_SCRIPT"
[[ -f "$WINDOWS_CSPROJ" ]]       || die "Missing $WINDOWS_CSPROJ"

if [[ "$SKIP_MACOS" -eq 0 ]]; then
    command -v swift >/dev/null || die "swift not on PATH — required for the macOS build"
    command -v create-dmg >/dev/null || warn "create-dmg missing; the macOS build script will fail at the DMG step"
fi

if [[ "$SKIP_WINDOWS" -eq 0 ]]; then
    command -v pwsh   >/dev/null || die "pwsh not on PATH — install with: brew install --cask powershell"
    command -v dotnet >/dev/null || die "dotnet SDK not on PATH — install with: brew install --cask dotnet-sdk"
fi

# ── Read current versions ──────────────────────────────────────────────────
# Portable extractor — macOS ships BSD awk without the 3-arg match(), so
# we use python3 (already required by the patch helpers) for both files.
_extract_plist_string() {
    # $1 = path, $2 = <key> name (extracts the immediately-following <string>).
    python3 -c "
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r'<key>' + re.escape(sys.argv[2]) + r'</key>\\s*\\n\\s*<string>([^<]+)</string>', src)
sys.stdout.write(m.group(1) if m else '')
" "$1" "$2"
}
read_macos_version()       { _extract_plist_string "$MACOS_BUILD_SCRIPT" CFBundleShortVersionString; }
read_macos_build_number()  { _extract_plist_string "$MACOS_BUILD_SCRIPT" CFBundleVersion; }
read_windows_version() {
    # <Version>1.15</Version> — first occurrence inside csproj.
    grep -oE '<Version>[^<]+</Version>' "$WINDOWS_CSPROJ" | head -1 | sed -E 's|</?Version>||g'
}

CURRENT_MACOS="$(read_macos_version || true)"
CURRENT_MACOS_BUILD="$(read_macos_build_number || true)"
CURRENT_WINDOWS="$(read_windows_version || true)"
[[ -n "$CURRENT_MACOS"       ]] || die "Could not parse current macOS version from $MACOS_BUILD_SCRIPT"
[[ -n "$CURRENT_MACOS_BUILD" ]] || die "Could not parse current macOS build number from $MACOS_BUILD_SCRIPT"
[[ -n "$CURRENT_WINDOWS"     ]] || die "Could not parse current Windows version from $WINDOWS_CSPROJ"

info "Current versions: macOS ${CURRENT_MACOS} (build ${CURRENT_MACOS_BUILD}), Windows ${CURRENT_WINDOWS}"

# ── Compute next versions ──────────────────────────────────────────────────
# semver bump for "X.Y.Z" strings; safely tolerates "X.Y" (treats Z as 0).
bump_semver() {
    local version="$1" kind="$2"
    IFS='.' read -r major minor patch <<< "$version"
    minor="${minor:-0}"
    patch="${patch:-0}"
    case "$kind" in
        patch) patch=$((patch + 1));;
        minor) minor=$((minor + 1)); patch=0;;
        major) major=$((major + 1)); minor=0; patch=0;;
    esac
    printf '%s.%s.%s' "$major" "$minor" "$patch"
}

NEW_MACOS="$CURRENT_MACOS"
NEW_MACOS_BUILD="$CURRENT_MACOS_BUILD"
NEW_WINDOWS="$CURRENT_WINDOWS"

if [[ "$NO_BUMP" -eq 1 ]]; then
    info "No-bump mode: reusing current versions."
elif [[ -n "$MACOS_VERSION" || -n "$WINDOWS_VERSION" || -n "$BUMP" ]]; then
    if [[ -n "$MACOS_VERSION" ]]; then
        NEW_MACOS="$MACOS_VERSION"
    elif [[ -n "$BUMP" ]]; then
        NEW_MACOS="$(bump_semver "$CURRENT_MACOS" "$BUMP")"
    fi
    # CFBundleVersion is an integer build counter; increment on any bump.
    if [[ "$NEW_MACOS" != "$CURRENT_MACOS" ]]; then
        # Only increment when the marketing string moves — otherwise leave it.
        if [[ "$CURRENT_MACOS_BUILD" =~ ^[0-9]+$ ]]; then
            NEW_MACOS_BUILD=$((CURRENT_MACOS_BUILD + 1))
        else
            warn "CFBundleVersion '$CURRENT_MACOS_BUILD' is not numeric; leaving as-is."
        fi
    fi

    if [[ -n "$WINDOWS_VERSION" ]]; then
        NEW_WINDOWS="$WINDOWS_VERSION"
    elif [[ -n "$BUMP" ]]; then
        NEW_WINDOWS="$(bump_semver "$CURRENT_WINDOWS" "$BUMP")"
    fi
else
    die "Nothing to do. Pass --bump, --macos, --windows, or --no-bump. See --help."
fi

# csproj AssemblyVersion / FileVersion need a four-part number. If the user
# passed "1.16" we expand to "1.16.0.0" for the assembly attributes.
windows_four_part() {
    local v="$1"
    IFS='.' read -r a b c d <<< "$v"
    a="${a:-0}"; b="${b:-0}"; c="${c:-0}"; d="${d:-0}"
    printf '%s.%s.%s.%s' "$a" "$b" "$c" "$d"
}
NEW_WINDOWS_ASSEMBLY="$(windows_four_part "$NEW_WINDOWS")"

# ── Summarise plan ─────────────────────────────────────────────────────────
step "Release plan"
info "macOS   : ${CURRENT_MACOS} (build ${CURRENT_MACOS_BUILD}) → ${NEW_MACOS} (build ${NEW_MACOS_BUILD})"
info "Windows : ${CURRENT_WINDOWS} → ${NEW_WINDOWS}  (assembly ${NEW_WINDOWS_ASSEMBLY})"
[[ "$SKIP_MACOS"   -eq 1 ]] && info "macOS build   : SKIPPED"
[[ "$SKIP_WINDOWS" -eq 1 ]] && info "Windows build : SKIPPED"
[[ "$DRY_RUN"      -eq 1 ]] && { warn "Dry run — no files edited, no builds run."; exit 0; }

# ── Patch versions ─────────────────────────────────────────────────────────
patch_macos_versions() {
    local short="$1" build="$2"
    # Match the *first* CFBundleShortVersionString/CFBundleVersion block
    # inside the heredoc. sed -i "" is macOS BSD syntax.
    #
    # We anchor on the <key>...</key> line and rewrite the *next* line's
    # <string>...</string> so we can't accidentally rewrite an unrelated
    # <string> tag.
    python3 - "$MACOS_BUILD_SCRIPT" "$short" "$build" <<'PY'
import re, sys
path, short, build = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, 'r') as f:
    src = f.read()

def swap(src, key, value):
    pattern = re.compile(
        r'(<key>' + re.escape(key) + r'</key>\s*\n\s*<string>)[^<]*(</string>)'
    )
    new_src, count = pattern.subn(lambda m: m.group(1) + value + m.group(2), src, count=1)
    if count != 1:
        raise SystemExit(f"Failed to patch {key} — expected exactly one match, found {count}")
    return new_src

src = swap(src, 'CFBundleShortVersionString', short)
src = swap(src, 'CFBundleVersion',            build)

with open(path, 'w') as f:
    f.write(src)
PY
}

patch_windows_versions() {
    local three_part="$1" four_part="$2"
    python3 - "$WINDOWS_CSPROJ" "$three_part" "$four_part" <<'PY'
import re, sys
path, three, four = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, 'r') as f:
    src = f.read()

def swap(src, tag, value):
    pattern = re.compile(r'(<' + tag + r'>)[^<]*(</' + tag + r'>)')
    new_src, count = pattern.subn(lambda m: m.group(1) + value + m.group(2), src, count=1)
    if count != 1:
        raise SystemExit(f"Failed to patch <{tag}> — expected exactly one match, found {count}")
    return new_src

src = swap(src, 'Version',         three)
src = swap(src, 'AssemblyVersion', four)
src = swap(src, 'FileVersion',     four)

with open(path, 'w') as f:
    f.write(src)
PY
}

if [[ "$NEW_MACOS" != "$CURRENT_MACOS" || "$NEW_MACOS_BUILD" != "$CURRENT_MACOS_BUILD" ]]; then
    step "Patching macOS version in $(realpath --relative-to="$REPO_ROOT" "$MACOS_BUILD_SCRIPT" 2>/dev/null || echo "$MACOS_BUILD_SCRIPT")"
    patch_macos_versions "$NEW_MACOS" "$NEW_MACOS_BUILD"
    ok "CFBundleShortVersionString → $NEW_MACOS,  CFBundleVersion → $NEW_MACOS_BUILD"
fi

if [[ "$NEW_WINDOWS" != "$CURRENT_WINDOWS" ]]; then
    step "Patching Windows version in $(realpath --relative-to="$REPO_ROOT" "$WINDOWS_CSPROJ" 2>/dev/null || echo "$WINDOWS_CSPROJ")"
    patch_windows_versions "$NEW_WINDOWS" "$NEW_WINDOWS_ASSEMBLY"
    ok "<Version> → $NEW_WINDOWS,  <AssemblyVersion>/<FileVersion> → $NEW_WINDOWS_ASSEMBLY"
fi

# ── Optional commit of the bump ────────────────────────────────────────────
if [[ "$COMMIT" -eq 1 ]] && git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if ! git diff --quiet -- "$MACOS_BUILD_SCRIPT" "$WINDOWS_CSPROJ"; then
        step "Committing version bump"
        git -C "$REPO_ROOT" add "$MACOS_BUILD_SCRIPT" "$WINDOWS_CSPROJ"
        git -C "$REPO_ROOT" commit -m "release: bump macOS to ${NEW_MACOS} (build ${NEW_MACOS_BUILD}), Windows to ${NEW_WINDOWS}"
        ok "Committed."
    fi
fi

# ── Build macOS ────────────────────────────────────────────────────────────
BUILD_START="$(date +%s)"
if [[ "$SKIP_MACOS" -eq 0 ]]; then
    step "Building macOS DMG"
    (
        cd "$(dirname "$MACOS_BUILD_SCRIPT")"
        bash "$(basename "$MACOS_BUILD_SCRIPT")"
    )
    MACOS_DMG="${REPO_ROOT}/macOS/OmniKeyAI.dmg"
    if [[ -f "$MACOS_DMG" ]]; then
        ok "macOS DMG: $MACOS_DMG  ($(du -h "$MACOS_DMG" | cut -f1))"
    else
        warn "macOS build script finished but $MACOS_DMG not found."
    fi
fi

# ── Build Windows ──────────────────────────────────────────────────────────
if [[ "$SKIP_WINDOWS" -eq 0 ]]; then
    step "Building Windows ZIP (win-x64, self-contained)"
    (
        cd "$(dirname "$WINDOWS_BUILD_SCRIPT")"
        pwsh -NoProfile -File "$(basename "$WINDOWS_BUILD_SCRIPT")"
    )
    WINDOWS_ZIP="${REPO_ROOT}/windows/OmniKeyAI-windows-win-x64.zip"
    if [[ -f "$WINDOWS_ZIP" ]]; then
        ok "Windows ZIP: $WINDOWS_ZIP  ($(du -h "$WINDOWS_ZIP" | cut -f1))"
    else
        warn "Windows build script finished but $WINDOWS_ZIP not found."
    fi
fi

BUILD_END="$(date +%s)"
ELAPSED=$(( BUILD_END - BUILD_START ))

# ── Final summary ──────────────────────────────────────────────────────────
step "Release complete in ${ELAPSED}s"
info "macOS   : ${NEW_MACOS} (build ${NEW_MACOS_BUILD})"
info "Windows : ${NEW_WINDOWS}"
[[ "$SKIP_MACOS"   -eq 0 && -f "${REPO_ROOT}/macOS/OmniKeyAI.dmg" ]] \
    && info "→ ${REPO_ROOT}/macOS/OmniKeyAI.dmg"
[[ "$SKIP_WINDOWS" -eq 0 && -f "${REPO_ROOT}/windows/OmniKeyAI-windows-win-x64.zip" ]] \
    && info "→ ${REPO_ROOT}/windows/OmniKeyAI-windows-win-x64.zip"
