## What and why

<!-- What problem does this solve? Link the issue if there is one. -->

## How it was verified

<!-- Commands you ran, manual steps, screenshots for macOS/Windows changes. -->

## Checklist

- [ ] `pnpm test` and `pnpm lint` pass
- [ ] `pnpm format` has been run (`pnpm format:check` is clean)
- [ ] Dependency changes are committed in `pnpm-lock.yaml` and installs cleanly with
      `pnpm install --frozen-lockfile`; no `yarn.lock` or `package-lock.json` was added
- [ ] Tooling changes (`package.json` scripts, `pnpm-workspace.yaml`, `turbo.json`) pass
      `pnpm test:tooling` and `pnpm test:cache` (disposable checkout only; deletes/restores build outputs)
- [ ] Native changes build (`swift build && swift test`, or `dotnet build` and `dotnet test windows.Tests/OmniKey.Windows.Tests.csproj`)
- [ ] If this touches `cli/**`, the patch version is bumped in both `cli/package.json` and
      `api/package.json` (a merge to `main` publishes to npm, and npm rejects republishing
      an existing version)
- [ ] No telemetry, analytics, or usage tracking was added — OmniKey sends nothing to its
      maintainers
