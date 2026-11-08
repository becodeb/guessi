# Build context is the repo root (docker-compose.yml: context ".", dockerfile
# "server/Dockerfile"), because the server reuses src/letra-stats.js.
FROM node:24-alpine

ENV NODE_ENV=production PORT=3000 DB_PATH=/data/guessi.db

# /app/server + /app/src keeps the server's "../src/letra-stats.js" import valid.
WORKDIR /app/server
# A package.json above src/ makes Node read the shared module as ESM.
RUN echo '{"type":"module","private":true}' > /app/package.json

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./
COPY src/letra-stats.js /app/src/letra-stats.js

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

CMD ["node", "--disable-warning=ExperimentalWarning", "index.js"]
