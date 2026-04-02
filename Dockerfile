FROM node:20-slim

# System deps for Claude Code (it needs git for some operations)
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# App directory
WORKDIR /app

# Install Node dependencies
COPY package.json ./
RUN npm install --production

# Copy bridge script
COPY telegram-bridge.js ./

# Persistent volume for Claude auth/config and session data
VOLUME /root/.claude

# Environment variables (override at runtime)
ENV CLAUDE_CODE_HEADLESS=1
ENV DISABLE_AUTOUPDATER=1
# TELEGRAM_BOT_TOKEN must be provided at runtime
# ANTHROPIC_API_KEY must be provided at runtime
# AUTHORIZED_USER_ID defaults to 6678076145 in the script

CMD ["node", "telegram-bridge.js"]
