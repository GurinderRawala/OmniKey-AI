# ─────────────────────────────────────────────────────────────────────────────
#  OmniKey AI — top-level Makefile
#
#  Thin wrapper around scripts/release.sh so common release flows work with a
#  single `make <target>` invocation. The script is the source of truth; the
#  Makefile just standardises the two or three commands you'd otherwise type
#  by hand.
#
#  Common targets:
#      make release        # bump minor on both apps, build macOS DMG + Windows ZIP
#      make release-patch  # same, but bump patch
#      make release-major  # same, but bump major
#      make dry-run        # preview the version bump without editing/building
#      make build          # rebuild current versions (no bump)
#      make macos          # bump minor + build ONLY macOS DMG
#      make windows        # bump minor + build ONLY Windows ZIP
#      make clean          # remove built artifacts (DMG, ZIP, publish dirs)
#      make help
# ─────────────────────────────────────────────────────────────────────────────

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

RELEASE_SCRIPT := scripts/release.sh

# Make sure the release script is executable even if a fresh clone stripped
# the +x bit (order-only prerequisite so it's touched at most once per make).
$(RELEASE_SCRIPT):
	@chmod +x $@

# Never treat these names as files.
.PHONY: help release release-minor release-patch release-major \
        dry-run build macos windows clean

# Default target when someone just runs `make`.
.DEFAULT_GOAL := help

## release          Bump MINOR on both apps and build macOS + Windows.
release: release-minor

## release-minor    Alias for `release`.
release-minor: $(RELEASE_SCRIPT)
	@$(RELEASE_SCRIPT) --bump minor

## release-patch    Bump PATCH on both apps and build macOS + Windows.
release-patch: $(RELEASE_SCRIPT)
	@$(RELEASE_SCRIPT) --bump patch

## release-major    Bump MAJOR on both apps and build macOS + Windows.
release-major: $(RELEASE_SCRIPT)
	@$(RELEASE_SCRIPT) --bump major

## dry-run          Print the planned MINOR bump without editing/building.
dry-run: $(RELEASE_SCRIPT)
	@$(RELEASE_SCRIPT) --bump minor --dry-run

## build            Rebuild current versions without bumping (no commit).
build: $(RELEASE_SCRIPT)
	@$(RELEASE_SCRIPT) --no-bump --no-commit

## macos            Bump MINOR and build ONLY the macOS DMG.
macos: $(RELEASE_SCRIPT)
	@$(RELEASE_SCRIPT) --bump minor --skip-windows

## windows          Bump MINOR and build ONLY the Windows ZIP.
windows: $(RELEASE_SCRIPT)
	@$(RELEASE_SCRIPT) --bump minor --skip-macos

## clean            Remove built DMG, ZIP, and dotnet publish output.
clean:
	@rm -f  macOS/OmniKeyAI.dmg macOS/OmniKeyAI.zip
	@rm -rf macOS/.build/release macOS/dmg-root macOS/OmniKeyAI.app
	@rm -f  windows/OmniKeyAI-windows-*.zip
	@rm -rf windows/.publish windows/bin windows/obj
	@echo "Cleaned build artifacts."

## help             Show this help.
help:
	@echo "OmniKey AI release targets:"
	@awk 'BEGIN { FS = ":.*##" } /^##/ { sub(/^## */, "", $$0); print "  " $$0 }' $(MAKEFILE_LIST) \
	    | awk 'BEGIN { FS = "  +" } NF==2 { printf "  %-16s %s\n", $$1, $$2; next } { print }'
	@echo
	@echo "For more control (explicit versions, dry-run, --no-commit, …) call"
	@echo "$(RELEASE_SCRIPT) directly. See $(RELEASE_SCRIPT) --help."
