# pnpm workspace build; the final image ships only API production dependencies.
FROM node:22-alpine AS build
WORKDIR /usr/src/app
# sqlite3 falls back to node-gyp on musl when no prebuilt binary is available.
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json ./api/package.json
COPY cli/package.json ./cli/package.json
COPY telegram/package.json ./telegram/package.json
RUN npm install --global "$(node -p 'require("./package.json").packageManager')" \
  && pnpm install --frozen-lockfile
COPY turbo.json eslint.config.mjs ./
COPY api ./api
RUN pnpm build:api \
  && pnpm --filter omnikey-ai-api deploy --prod /out/api

FROM node:22-alpine AS runtime
WORKDIR /usr/src/app
ENV NODE_ENV=production
COPY --from=build /out/api ./api
# Keep existing public/download/installer paths and the API entrypoint.
COPY --from=build /usr/src/app/api/public ./public
COPY macOS/OmniKeyAI.dmg ./macOS/OmniKeyAI.dmg
COPY windows/OmniKeyAI-windows-win-x64.zip ./windows/OmniKeyAI-windows-win-x64.zip
COPY scripts/install.sh ./install.sh
COPY scripts/install.ps1 ./install.ps1
ENV PORT=8080
EXPOSE 8080
CMD ["node", "api/dist/index.js"]
