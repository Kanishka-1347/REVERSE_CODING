FROM node:20-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Package.json package.json
RUN npm install --omit=dev

COPY Backend.js ./

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm", "start"]