FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Bun globally (not per-user)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code@latest

ENV DISABLE_AUTOUPDATER=1

# Prepare home directory for non-root user
RUN mkdir -p /home/node/.claude /home/node/.claude/channels/telegram \
    && chown -R node:node /home/node

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER node
WORKDIR /home/node
ENV HOME=/home/node

CMD ["/entrypoint.sh"]
