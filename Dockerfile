FROM ghcr.io/jafffff/claude-telegram-bridge-base:latest

WORKDIR /app
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

CMD ["/app/start.sh"]
