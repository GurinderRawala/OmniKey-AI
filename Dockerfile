# Multi-stage Dockerfile for Omnikey TypeScript backend on Cloud Run.
# The repo is a Yarn monorepo; only the api/ workspace is shipped.

# --- Build stage ---
FROM node:22-alpine AS build

WORKDIR /usr/src/app

# Install workspace dependencies. Copy the lockfile + every workspace manifest
# so Yarn can resolve the full dependency graph before we copy the rest of
# the source tree.
COPY package.json yarn.lock ./
COPY api/package.json ./api/package.json
COPY cli/package.json ./cli/package.json
COPY telegram/package.json ./telegram/package.json
RUN corepack prepare yarn@1.22.22 --activate \
  && yarn install --frozen-lockfile

# Copy the api workspace source + shared runtime assets needed at build time.
COPY api ./api
COPY public ./public
COPY macOS/OmniKeyAI.dmg ./macOS/OmniKeyAI.dmg
COPY windows/OmniKeyAI-windows-win-x64.zip ./windows/OmniKeyAI-windows-win-x64.zip
COPY scripts/install.sh ./install.sh

# Build the api workspace (compiles api/src -> api/dist).
RUN yarn workspace omnikey-ai-api run build


# --- Runtime stage ---
FROM node:22-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Install production-only deps for the api workspace.
COPY package.json yarn.lock ./
COPY api/package.json ./api/package.json
COPY cli/package.json ./cli/package.json
COPY telegram/package.json ./telegram/package.json
RUN corepack prepare yarn@1.22.22 --activate \
  && yarn install --frozen-lockfile --production

# Copy compiled JS and runtime assets from the build stage.
COPY --from=build /usr/src/app/api/dist ./api/dist
COPY --from=build /usr/src/app/public ./public
COPY macOS/OmniKeyAI.dmg ./macOS/OmniKeyAI.dmg
COPY --from=build /usr/src/app/windows/OmniKeyAI-windows-win-x64.zip ./windows/OmniKeyAI-windows-win-x64.zip
COPY scripts/install.sh ./install.sh

# Cloud Run expects the container to listen on this port
ENV PORT=8080
EXPOSE 8080

# Start the api server. The workspace's package.json declares
# "main": "dist/index.js"; we invoke it explicitly to avoid relying on cwd.
CMD ["node", "api/dist/index.js"]
