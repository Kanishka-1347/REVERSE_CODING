FROM node:20-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc g++ python3 default-jdk-headless git ca-certificates \
    && git clone --depth 1 https://github.com/vlang/v /tmp/vlang \
    && make -C /tmp/vlang \
    && cp /tmp/vlang/v /usr/local/bin/v \
    && rm -rf /tmp/vlang \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Package.json package.json
RUN npm install --omit=dev

COPY Backend.js ./

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm", "start"]