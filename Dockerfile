FROM node:20-slim

# Install Playwright system dependencies
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libatspi2.0-0 libxshmfence1 \
    fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Install Playwright browsers (Chromium only)
RUN npx playwright install chromium

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/
COPY config.yaml ./

# Build TypeScript
RUN npm run build

# Copy EJS views to dist (not compiled by tsc)
RUN cp -r src/dashboard/views dist/dashboard/views

# Data volume
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "dist/index.js"]
