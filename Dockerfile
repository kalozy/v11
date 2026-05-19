FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    python3 \
    python3-distutils \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3

RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .

RUN mkdir -p data/bot/auth data/bot/rm-media

EXPOSE 3000

CMD ["node", "src/server.js"]
