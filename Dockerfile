# syntax=docker/dockerfile:1.6

FROM node:20-slim AS builder

# better-sqlite3 builds from source via node-gyp
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 g++ make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build \
    && cp -r src/dashboard/views dist/dashboard/views


FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libatspi2.0-0 libxshmfence1 \
    fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Install Chromium as root so the binary lives in /root/.cache; move it to
# node's home and re-own so the non-root user can launch it at runtime.
RUN npx playwright install chromium \
    && mkdir -p /home/node/.cache \
    && mv /root/.cache/ms-playwright /home/node/.cache/ms-playwright \
    && mkdir -p /app/data \
    && chown -R node:node /app /home/node/.cache

USER node

EXPOSE 3000

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000', r => process.exit(r.statusCode === 401 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]
