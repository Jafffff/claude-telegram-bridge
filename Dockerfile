FROM node:20-slim

# System deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates curl tmux && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user (Claude Code blocks --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash claude
USER claude
WORKDIR /home/claude

# Install Claude Code globally for this user
RUN npm install -g @anthropic-ai/claude-code

# Persistent volume for auth, config, channels
VOLUME /home/claude/.claude

# Copy startup script
COPY --chown=claude:claude start.sh /home/claude/start.sh
RUN chmod +x /home/claude/start.sh

ENV DISABLE_AUTOUPDATER=1
ENV HOME=/home/claude

CMD ["/home/claude/start.sh"]
