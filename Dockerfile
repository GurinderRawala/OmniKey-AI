# Multi-stage Dockerfile for Omnikey TypeScript backend on Cloud Run

# --- Build stage ---
FROM node:20-alpine AS build

# Create app directory
WORKDIR /usr/src/app

# Install dependencies (including devDependencies for TypeScript build)
COPY package.json yarn.lock ./
RUN corepack enable \
  && yarn install --frozen-lockfile

# Copy source, proto definitions, and TypeScript config
COPY tsconfig.json ./
COPY src ./src
COPY macOS/OmniKeyAI.dmg ./macOS/OmniKeyAI.dmg

# Build TypeScript to JavaScript
RUN npm run build


# --- Runtime stage ---
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Only install production dependencies
COPY package.json yarn.lock ./
RUN corepack enable \
  && yarn install --production --frozen-lockfile

# Copy compiled JS and runtime assets from build stage
COPY --from=build /usr/src/app/dist ./dist
COPY macOS/OmniKeyAI.dmg ./macOS/OmniKeyAI.dmg

# Cloud Run expects the container to listen on this port
ENV PORT=8080
EXPOSE 8080

# Start the server
CMD ["node", "dist/index.js"]
