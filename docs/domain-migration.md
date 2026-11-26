# getomnikey.com migration

The canonical public website is https://getomnikey.com. Both domains map to the
same `omnikeyai-saas` Cloud Run service in `omnikeyai`, region `us-central1`.
Always specify `--account=gurinderrawala@gmail.com --project=omnikeyai` with gcloud;
do not change the developer's active account/project.

## Cutover

1. Map getomnikey.com to the existing service and configure all Google-assigned
   A/AAAA records. Preserve verification TXT, email security, and Domain Connect.
2. Wait for DomainMapping Ready=True and validate HTTPS without disabling TLS checks.
3. Deploy the canonical URLs and redirect middleware with
   `OMNIKEY_WEBSITE_REDIRECT_ENABLED=false` (default). This can safely happen before
   certificate provisioning completes.
4. Validate the homepage, blog, docs, downloads, installers, and both update feeds
   on the new domain. Check download headers with HEAD rather than fetching binaries.
5. Enable `OMNIKEY_WEBSITE_REDIRECT_ENABLED=true` on the Cloud Run service only.
6. Check that old website URLs redirect with paths and query strings intact, while
   legacy client endpoints still return their original responses.

Only GET/HEAD website requests on omnikeyai.ca, www.omnikeyai.ca, and
www.getomnikey.com redirect. APIs, /macos/*, /windows/*, /downloads/*, /health,
install.sh, install.ps1, and /.well-known/* do not. POST and local daemon traffic
are unchanged. The direct run.app endpoint remains supported for older clients.
Do not redirect all Cloud Run requests or replace the service URL.

Future Windows builds use the new update endpoint. Existing binaries keep using
their original endpoints; keep the old domain and its certificate renewed.
macOS Sparkle feeds derive from OMNIKEY_BACKEND_URL at build time: use
https://getomnikey.com for production builds; do not change the local-dev default.
No desktop binary rebuild is needed just to keep old clients working.

## Rollback

Set OMNIKEY_WEBSITE_REDIRECT_ENABLED=false (or route traffic back to the preceding
Cloud Run revision). Do not delete the old domain mapping. Permanent redirects
may be cached by browsers, which is why HTTPS and compatibility checks precede
activation. Leave the new domain mapped when rolling back app behavior.

The `release` branch triggers the existing Cloud Build deployment. The main branch
publishes npm only when cli/** changes; API/CLI versions must be bumped together.
After npm publication, push the matching v* tag to build Homebrew artifacts and
open the formula-update PRs. Do not overwrite historical release versions.
