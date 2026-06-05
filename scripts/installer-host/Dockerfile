# OmniKey AI - Installer-script host
#
# Tiny static container that serves the one-line installer scripts so the
# public install URL can be short, e.g.:
#
#   curl -fsSL https://omnikeyai.ca/install.sh | bash
#   iwr -useb https://omnikeyai.ca/install.ps1 | iex
#
# Designed to deploy on Google Cloud Run (listens on $PORT, default 8080)
# behind a custom domain mapped to omnikeyai.ca.
#
# Build (run from the repo root so the build context contains scripts/):
#   docker build -f scripts/installer-host/Dockerfile -t omnikey-installer-host .
#
# Push to Google Artifact Registry (example):
#   docker tag omnikey-installer-host \
#     us-central1-docker.pkg.dev/$PROJECT/omnikey/installer-host:latest
#   docker push \
#     us-central1-docker.pkg.dev/$PROJECT/omnikey/installer-host:latest
#
# Deploy to Cloud Run:
#   gcloud run deploy omnikey-installer-host \
#     --image us-central1-docker.pkg.dev/$PROJECT/omnikey/installer-host:latest \
#     --region us-central1 --allow-unauthenticated --port 8080
#
# Then map the custom domain (omnikeyai.ca) to this Cloud Run service.

FROM nginx:1.27-alpine

# Copy the install scripts straight from the repo into the web root.
# Build context must be the repo root (see header).
COPY scripts/install.sh  /usr/share/nginx/html/install.sh
COPY scripts/install.ps1 /usr/share/nginx/html/install.ps1

# Friendly landing page at "/".
COPY scripts/installer-host/index.html /usr/share/nginx/html/index.html

# Nginx config template — Cloud Run injects $PORT (defaults to 8080 locally).
COPY scripts/installer-host/nginx.conf.template /etc/nginx/templates/default.conf.template

ENV PORT=8080
EXPOSE 8080

# The official nginx image already runs `envsubst` on /etc/nginx/templates/*.template
# and then execs nginx, so no custom entrypoint is required.
