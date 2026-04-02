FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally (as root)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY telegram-bridge.js ./
COPY start.sh ./
RUN chmod +x /app/start.sh

ENV DISABLE_AUTOUPDATER=1

CMD ["/app/start.sh"]
