# ---- Build stage ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- Runtime stage ----
FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache dumb-init tzdata
ENV NODE_ENV=production \
    TZ=Asia/Kolkata

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./

RUN mkdir -p logs data && chown -R node:node /app
USER node

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD pgrep -f "node dist/index.js" > /dev/null || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
