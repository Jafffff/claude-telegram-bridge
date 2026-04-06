FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl unzip cron \
    && rm -rf /var/lib/apt/lists/*

# Install Bun globally (not per-user)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# Install Claude Code CLI and gogcli globally
RUN npm install -g @anthropic-ai/claude-code@latest gogcli@0.1.0

ENV DISABLE_AUTOUPDATER=1

# Prepare home directory for non-root user
RUN mkdir -p /home/node/.claude /home/node/.claude/channels/telegram \
    && chown -R node:node /home/node

COPY entrypoint.sh /entrypoint.sh
COPY CLAUDE.md /home/node/CLAUDE.md
RUN chmod +x /entrypoint.sh

# Entrypoint runs as root, drops to 'node' user via su for Claude Code
WORKDIR /home/node

CMD ["/entrypoint.sh"]
