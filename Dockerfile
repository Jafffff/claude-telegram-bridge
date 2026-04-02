FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY telegram-bridge.js ./

ENV DISABLE_AUTOUPDATER=1

CMD ["node", "telegram-bridge.js"]
