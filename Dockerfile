# Multi-stage Dockerfile for Omnikey TypeScript backend on Cloud Run

# --- Build stage ---
FROM node:22-alpine AS build

# Create app directory
WORKDIR /usr/src/app

# Install dependencies (including devDependencies for TypeScript build)
COPY package.json yarn.lock ./
RUN corepack prepare yarn@stable --activate \
  && yarn install --frozen-lockfile

# Copy source, proto definitions, and TypeScript config
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY macOS/OmniKeyAI.dmg ./macOS/OmniKeyAI.dmg
COPY windows/OmniKeyAI-windows-win-x64.zip ./windows/OmniKeyAI-windows-win-x64.zip

# Build TypeScript to JavaScript
RUN npm run build


# --- Runtime stage ---
FROM node:22-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Only install production dependencies
COPY package.json yarn.lock ./
RUN corepack prepare yarn@stable --activate \
  && yarn install --production --frozen-lockfile

# Copy compiled JS and runtime assets from build stage
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/public ./public
COPY macOS/OmniKeyAI.dmg ./macOS/OmniKeyAI.dmg
COPY --from=build /usr/src/app/windows/OmniKeyAI-windows-win-x64.zip ./windows/OmniKeyAI-windows-win-x64.zip

# Cloud Run expects the container to listen on this port
ENV PORT=8080
EXPOSE 8080

# Start the server
CMD ["node", "dist/index.js"]
