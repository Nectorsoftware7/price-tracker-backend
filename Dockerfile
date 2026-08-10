FROM node:20-slim

# Playwright (used for Flipkart/Meesho/JioMart scraping) needs Chromium + its OS deps.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npx playwright install chromium

COPY . .

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "src/server.js"]
