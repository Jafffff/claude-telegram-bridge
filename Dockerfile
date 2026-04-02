FROM ubuntu:24.04
LABEL language="bash"

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/root
ENV DISABLE_AUTOUPDATER=1

WORKDIR /app

# Install Node 20 + dependencies
RUN apt-get update && apt-get install -y curl ca-certificates git && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Persistent data directory
RUN mkdir -p /data

COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

CMD ["/app/start.sh"]
