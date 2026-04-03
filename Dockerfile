FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .npmrc ./
RUN npm install
COPY telegram-bridge.js ./

ENV HOME=/root
ENV DISABLE_AUTOUPDATER=1

CMD ["node", "telegram-bridge.js"]
