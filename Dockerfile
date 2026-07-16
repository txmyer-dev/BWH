FROM node:24-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY . .
RUN npm ci && npm run build

FROM node:24-bookworm-slim AS runner

ENV NODE_ENV=production
ENV REMOTION_BUNDLE_PATH=/app/remotion-bundle
ENV REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates chromium ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/remotion-bundle ./remotion-bundle
USER node
EXPOSE 3000
CMD ["npm", "start"]
