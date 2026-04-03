FROM node:20-slim

# System packages: headless browser, OCR, audio/video, image processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl \
    chromium \
    tesseract-ocr \
    ffmpeg \
    imagemagick \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install Whisper (speech-to-text)
RUN python3 -m venv /opt/whisper && \
    /opt/whisper/bin/pip install --no-cache-dir openai-whisper

# Install Playwright browsers
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN npx playwright install --with-deps chromium 2>/dev/null || true

# Chromium Docker flags
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV CHROMIUM_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu --single-process --no-zygote"
ENV PUPPETEER_CHROMIUM_REVISION=skip
ENV PATH="/opt/whisper/bin:$PATH"

WORKDIR /app

COPY package.json .npmrc ./
RUN npm install
COPY telegram-bridge.js CLAUDE.md ./

ENV HOME=/root
ENV DISABLE_AUTOUPDATER=1

CMD ["node", "telegram-bridge.js"]
