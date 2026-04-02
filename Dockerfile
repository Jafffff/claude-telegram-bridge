FROM node:20-slim
LABEL language="bash"

ENV HOME=/root
ENV DISABLE_AUTOUPDATER=1

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN mkdir -p /data

COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

CMD ["/app/start.sh"]
