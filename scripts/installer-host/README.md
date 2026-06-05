# OmniKey AI installer host

Tiny static container that serves the one-line installer scripts under a
short, branded URL such as:

```
https://omnikeyai.ca/install.sh
https://omnikeyai.ca/install.ps1
```

The scripts themselves live in [`../install.sh`](../install.sh) and
[`../install.ps1`](../install.ps1). This image just bakes them into an
`nginx:alpine` container and serves them with the right content-type and
caching headers.

## Layout

| File | Purpose |
|---|---|
| `Dockerfile` | Builds the static-site container on top of `nginx:1.27-alpine`. |
| `nginx.conf.template` | Server config; `${PORT}` is expanded at start (Cloud Run friendly). |
| `index.html` | Landing page at `/` with the install one-liners. |
| `.dockerignore` | Trims the build context to the files we actually need. |

## Endpoints

| Path | Content |
|---|---|
| `/` | Landing page with the one-liners |
| `/install.sh` | macOS / Linux installer (served as `text/x-shellscript`) |
| `/install.ps1` | Windows PowerShell installer (served as `text/plain`) |
| `/healthz` | Returns `ok` (200) for uptime / load-balancer checks |

## Build

Run from the **repo root** so the build context contains `scripts/`:

```bash
docker build -f scripts/installer-host/Dockerfile \
  -t omnikey-installer-host:latest .
```

Quick smoke test locally:

```bash
docker run --rm -p 8080:8080 omnikey-installer-host:latest
# In another terminal:
curl -sI http://localhost:8080/install.sh
curl -s  http://localhost:8080/healthz
```

## Push to Google Artifact Registry

```bash
PROJECT=<your-gcp-project>
REGION=us-central1
REPO=omnikey
IMAGE=installer-host

# One-time: create the Artifact Registry repo
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker --location="$REGION" \
  --project="$PROJECT" || true

gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet

docker tag omnikey-installer-host:latest \
  "$REGION-docker.pkg.dev/$PROJECT/$REPO/$IMAGE:latest"
docker push \
  "$REGION-docker.pkg.dev/$PROJECT/$REPO/$IMAGE:latest"
```

## Deploy to Cloud Run

```bash
gcloud run deploy omnikey-installer-host \
  --image "$REGION-docker.pkg.dev/$PROJECT/$REPO/$IMAGE:latest" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 0 --max-instances 5 \
  --memory 128Mi --cpu 1 \
  --project "$PROJECT"
```

## Map the custom domain (`omnikeyai.ca`)

1. In the Google Cloud Console, go to **Cloud Run → Manage Custom Domains**
   (or run `gcloud beta run domain-mappings create`).
2. Map `omnikeyai.ca` (and optionally `www.omnikeyai.ca`) to the
   `omnikey-installer-host` service.
3. Add the DNS records (A/AAAA or CNAME) shown by Cloud Run at your
   registrar. Google-managed TLS provisions automatically once DNS resolves.

Once DNS propagates, the final install commands become:

```bash
# macOS / Linux
curl -fsSL https://omnikeyai.ca/install.sh | bash

# Windows (PowerShell)
iwr -useb https://omnikeyai.ca/install.ps1 | iex
```

## Updating the installer scripts

The scripts are baked into the image at build time, so any change to
`scripts/install.sh` or `scripts/install.ps1` needs a rebuild + redeploy:

```bash
docker build -f scripts/installer-host/Dockerfile \
  -t "$REGION-docker.pkg.dev/$PROJECT/$REPO/$IMAGE:latest" .
docker push "$REGION-docker.pkg.dev/$PROJECT/$REPO/$IMAGE:latest"
gcloud run deploy omnikey-installer-host \
  --image "$REGION-docker.pkg.dev/$PROJECT/$REPO/$IMAGE:latest" \
  --region "$REGION" --project "$PROJECT"
```

The nginx config sets `Cache-Control: public, max-age=300`, so freshly
deployed scripts go live within ~5 minutes of a successful redeploy.
