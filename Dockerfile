FROM node:24-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY . .
RUN npm ci && npm run build

FROM node:24-bookworm-slim AS runner

ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /app ./
USER node
EXPOSE 3000
CMD ["npm", "start"]
