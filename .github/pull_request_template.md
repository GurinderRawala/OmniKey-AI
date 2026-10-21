## What and why

<!-- What problem does this solve? Link the issue if there is one. -->

## How it was verified

<!-- Commands you ran, manual steps, screenshots for macOS/Windows changes. -->

## Checklist

- [ ] `yarn test` passes
- [ ] `yarn format` has been run
- [ ] Native changes build (`swift build && swift test`, or `dotnet build`)
- [ ] If this touches `cli/**`, the patch version is bumped in `cli/package.json`,
      `api/package.json`, and `cli/package-lock.json` (a merge to `main` publishes to npm,
      and npm rejects republishing an existing version)
- [ ] No telemetry, analytics, or usage tracking was added — OmniKey sends nothing to its
      maintainers
