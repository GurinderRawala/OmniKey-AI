# OmniKey AI Release Runbook

Use this checklist when releasing the macOS app, Windows app, API, CLI/npm package, and Homebrew formula. Run commands from the repository root unless noted otherwise.

## Version sources

The products do not currently share one version number.

| Product | Version source | Additional update metadata |
| --- | --- | --- |
| CLI | `cli/package.json` and `cli/package-lock.json` | Git tag `v<CLI_VERSION>` drives the GitHub CLI release and Homebrew workflow. |
| API | `api/package.json` | Deploy the API/container after merging the release artifacts. |
| macOS | `CFBundleShortVersionString` and `CFBundleVersion` in `macOS/build_release_dmg.sh` | The matching `shortVersion` and `bundleVersion` in `api/src/index.ts` drive `/macos/appcast`. |
| Windows | `Version`, `AssemblyVersion`, and `FileVersion` in `windows/OmniKey.Windows.csproj` | The matching `WIN_VERSION` in `api/src/index.ts` drives `/windows/update`. |

For a minor release, increment the middle SemVer component and reset the patch component, for example `1.6.28` to `1.7.0`. Always increment the numeric macOS `CFBundleVersion`, even when rebuilding the same marketing version.

## 1. Prepare and inspect

1. Start from `main` with a clean worktree:

   ```bash
   git switch main
   git fetch origin --prune --tags
   git pull --ff-only origin main
   git status --short
   ```

2. Confirm `main` and `release` are in the expected state:

   ```bash
   git rev-list --left-right --count main...origin/main
   git rev-list --left-right --count origin/release...origin/main
   git tag --sort=-version:refname | head
   ```

3. Inspect current versions before editing:

   ```bash
   node -e "for (const p of ['api/package.json','cli/package.json']) console.log(p, require('./'+p).version)"
   rg -n 'CFBundleVersion|CFBundleShortVersionString' macOS/build_release_dmg.sh
   rg -n 'bundleVersion|shortVersion|WIN_VERSION' api/src/index.ts
   rg -n '<Version>|<AssemblyVersion>|<FileVersion>' windows/OmniKey.Windows.csproj
   ```

4. Review the commits since the previous CLI tag and decide release notes:

   ```bash
   git log --oneline v<PREVIOUS_CLI_VERSION>..main
   ```

## 2. Bump versions

### CLI and API

Update:

- `cli/package.json`
- the top-level version and `packages[""]` version in `cli/package-lock.json`
- `api/package.json`

The CLI and API normally use the same version. Do not manually update `Formula/omnikey-cli.rb` before the release workflow; it inserts the release version and checksums after building the tagged artifacts.

### macOS

Update both values in `macOS/build_release_dmg.sh`:

- `CFBundleShortVersionString`: user-facing app version
- `CFBundleVersion`: monotonically increasing integer build number

Update the same values in `api/src/index.ts`:

- `shortVersion`
- `bundleVersion`

If these values do not match, existing macOS apps may not receive the correct Sparkle update notification.

### Windows

Update `windows/OmniKey.Windows.csproj`:

- `<Version>X.Y.Z</Version>`
- `<AssemblyVersion>X.Y.Z.0</AssemblyVersion>`
- `<FileVersion>X.Y.Z.0</FileVersion>`

Update `WIN_VERSION` in `api/src/index.ts` to the same `X.Y.Z` value. The Windows update endpoint reads this constant.

### Release helper

`scripts/release.sh` can bump and build the desktop apps:

```bash
scripts/release.sh --dry-run --bump minor
scripts/release.sh --bump minor --no-commit
```

Explicit versions can be supplied when macOS and Windows versions differ:

```bash
scripts/release.sh --macos <MAC_VERSION> --windows <WINDOWS_VERSION> --no-commit
```

The helper does **not** bump the CLI/API package versions or the update constants in `api/src/index.ts`; update and verify those separately.

## 3. Validate source before packaging

Install dependencies using the repository lockfile if needed:

```bash
yarn install --frozen-lockfile
```

Run the API tests and build:

```bash
(cd api && yarn test && yarn build)
```

Build and smoke-test the CLI:

```bash
yarn workspace omnikey-cli run build
node cli/dist/index.js --version
```

Build the macOS app with Xcode:

```bash
(cd macOS && xcodebuild -scheme OmniKeyAI -destination 'platform=macOS,arch=arm64' clean build)
```

Build Windows when a suitable PowerShell/.NET environment is available:

```bash
pwsh -NoProfile -File windows/build_release_zip.ps1
```

Finally:

```bash
git diff --check
git status --short
```

Do not proceed if a failure is caused by the release changes. Existing unrelated warnings should be recorded, not described as newly introduced.

## 4. Build the production macOS bundle

### Prerequisites

The macOS packaging script requires:

- Xcode/Swift
- `create-dmg`
- a valid `Developer ID Application` signing identity
- the `omnikey-notary` notarytool keychain profile

Check them first:

```bash
command -v swift
command -v create-dmg
security find-identity -v -p codesigning
xcrun notarytool history --keychain-profile omnikey-notary >/dev/null
```

### Build

The production backend URL must be present **before** running the build. This value is embedded in `Info.plist`, and the Sparkle feed becomes `<URL>/macos/appcast`.

```bash
cd macOS
export OMNIKEY_BACKEND_URL='https://omnikeyai.ca'
bash build_release_dmg.sh
cd ..
```

The script builds a universal arm64/x86_64 binary, creates `OmniKeyAI.app`, signs it with Developer ID, submits it for notarization, staples the ticket, and creates `OmniKeyAI.dmg` and `OmniKeyAI.zip`.

### Verify the actual production bundle

```bash
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' macOS/OmniKeyAI.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' macOS/OmniKeyAI.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c 'Print :OMNIKEY_BACKEND_URL' macOS/OmniKeyAI.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c 'Print :SUFeedURL' macOS/OmniKeyAI.app/Contents/Info.plist
lipo -archs macOS/OmniKeyAI.app/Contents/MacOS/OmniKeyAI
codesign --verify --deep --strict --verbose=2 macOS/OmniKeyAI.app
spctl --assess --type execute --verbose=2 macOS/OmniKeyAI.app
xcrun stapler validate macOS/OmniKeyAI.app
shasum -a 256 macOS/OmniKeyAI.dmg macOS/OmniKeyAI.zip
```

Expected production values include:

- backend: `https://omnikeyai.ca`
- Sparkle feed: `https://omnikeyai.ca/macos/appcast`
- architectures: `arm64` and `x86_64`
- Gatekeeper source: `Notarized Developer ID`

Open the packaged app—not a raw SwiftPM executable—and smoke-test the changed UI. A uniquely named test bundle can be used during development, but the shipped artifact must be the signed/notarized `macOS/OmniKeyAI.app` and DMG.

`macOS/OmniKeyAI.app` and `.zip` are ignored; `macOS/OmniKeyAI.dmg` is tracked because the API Docker image serves it from `/macos/download`.

## 5. Build the Windows bundle

Set the public backend before packaging:

```bash
export OMNIKEY_BACKEND_URL='https://omnikeyai.ca'
pwsh -NoProfile -File windows/build_release_zip.ps1
```

The script publishes a self-contained `win-x64` single-file app and creates:

```text
windows/OmniKeyAI-windows-win-x64.zip
```

Verify the archive exists and inspect its checksum:

```bash
ls -lh windows/OmniKeyAI-windows-win-x64.zip
shasum -a 256 windows/OmniKeyAI-windows-win-x64.zip
```

Test the extracted executable on Windows, including launch, update check, tray behavior, hotkeys, settings, and the release-specific workflow. The ZIP is copied into the API Docker image and served by the Windows download/update routes.

## 6. Commit and push `main`

Commit source, version metadata, tests, and the newly built desktop artifacts together. Use `git status` to avoid adding unrelated files.

```bash
git add <reviewed-source-and-version-files>
git add -f macOS/OmniKeyAI.dmg
# Add the Windows ZIP when it changed and is part of this release.
git add -f windows/OmniKeyAI-windows-win-x64.zip
git commit -m "release: ship CLI <CLI_VERSION>, macOS <MAC_VERSION>, Windows <WINDOWS_VERSION>"
git push origin main
```

The Dockerfile copies both desktop artifacts into the API image. Pushing only version metadata without rebuilding and committing the artifacts causes the download endpoint to serve an old application.

## 7. Publish CLI/npm, GitHub release, and Homebrew

Pushing CLI changes to `main` triggers `.github/workflows/publish-cli.yaml`, which builds the workspaces and publishes `cli/` to npm.

Create and push the CLI tag from the intended `main` commit:

```bash
git tag -a v<CLI_VERSION> <MAIN_COMMIT> -m "Release v<CLI_VERSION>"
git push origin v<CLI_VERSION>
```

The `Release Omnikey CLI` workflow then:

1. builds arm64 and x86_64 macOS CLI tarballs;
2. creates/updates the GitHub release;
3. computes release checksums;
4. updates `Formula/omnikey-cli.rb` on `main`; and
5. pushes the formula to `GurinderRawala/homebrew-omnikey` using `HOMEBREW_TAP_PAT`.

Watch both workflows to completion:

```bash
gh run list --repo GurinderRawala/OmniKey-AI --limit 10
gh run watch <NPM_RUN_ID> --repo GurinderRawala/OmniKey-AI --exit-status
gh run watch <RELEASE_RUN_ID> --repo GurinderRawala/OmniKey-AI --exit-status
```

The release workflow commits the generated formula back to `main`, so fast-forward the local branch after it succeeds:

```bash
git switch main
git pull --ff-only origin main
```

Verify publication:

```bash
npm view omnikey-cli version
gh release view v<CLI_VERSION> --repo GurinderRawala/OmniKey-AI
curl -fsSL https://raw.githubusercontent.com/GurinderRawala/homebrew-omnikey/main/omnikey-cli.rb | sed -n '1,25p'
```

Optionally validate installation from the tap on a clean machine or after refreshing Homebrew:

```bash
brew update
brew upgrade GurinderRawala/omnikey/omnikey-cli
omnikey --version
```

## 8. Merge final `main` into `release`

Do this **after** automated workflow commits and rebuilt desktop artifacts are on `main`, otherwise `release` will be missing the final formula or app bundle.

```bash
git switch release
git pull --ff-only origin release
git merge --no-ff main -m "Merge main into release for v<CLI_VERSION>"
git push origin release
git switch main
```

If `release` has moved independently, inspect and resolve the divergence rather than force-pushing.

## 9. Deploy the API and update endpoints

Deploy from the final release commit using the project's normal production deployment process. The image must contain the new:

- compiled API source/version;
- `macOS/OmniKeyAI.dmg`;
- `windows/OmniKeyAI-windows-win-x64.zip`;
- macOS appcast values; and
- Windows update version.

After deployment, verify public behavior:

```bash
curl -fsSL https://omnikeyai.ca/macos/appcast
curl -I https://omnikeyai.ca/macos/download
curl -fsSL https://omnikeyai.ca/windows/update
curl -I https://omnikeyai.ca/windows/download
```

Check that the appcast reports the new macOS short/build versions and that the Windows endpoint reports the new Windows version. Test update notifications from an older installed macOS and Windows build.

## 10. Write release notes

Edit the GitHub release with concise bullet points describing user-visible changes, compatibility/build changes, and package updates:

```bash
gh release edit v<CLI_VERSION> \
  --repo GurinderRawala/OmniKey-AI \
  --notes-file /path/to/release-notes.md
```

Keep the full changelog link:

```text
https://github.com/GurinderRawala/OmniKey-AI/compare/v<PREVIOUS_VERSION>...v<CLI_VERSION>
```

## 11. Final verification checklist

- [ ] API and CLI versions match the intended release.
- [ ] macOS marketing version and numeric build were incremented.
- [ ] `api/src/index.ts` macOS appcast values match the packaged app.
- [ ] Windows project version and `WIN_VERSION` match.
- [ ] API tests and production build passed.
- [ ] CLI build passed and `omnikey --version` is correct.
- [ ] macOS clean Xcode build passed.
- [ ] macOS production bundle was built with `OMNIKEY_BACKEND_URL=https://omnikeyai.ca`.
- [ ] macOS app is universal, signed, notarized, stapled, and Gatekeeper accepted.
- [ ] Windows ZIP was rebuilt and tested on Windows.
- [ ] New DMG and Windows ZIP are committed, not stale artifacts.
- [ ] `main` was pushed.
- [ ] CLI npm workflow succeeded.
- [ ] GitHub release/Homebrew workflow succeeded.
- [ ] npm and the external Homebrew tap show the new CLI version.
- [ ] Workflow-generated formula commit was pulled into local `main`.
- [ ] Final `main` was merged and pushed to `release`.
- [ ] API was deployed with both new desktop artifacts.
- [ ] Public macOS appcast/download and Windows update/download endpoints were verified.
- [ ] Update notification was tested from an older app version.
- [ ] GitHub release notes were updated.
- [ ] Final worktree is clean.
