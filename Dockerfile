# Any container host will take this: Render, Railway, Fly, Cloud Run, a VPS.
FROM node:22-alpine

WORKDIR /app

# Install dependencies first so the layer caches across code changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 8080

# Don't run as root.
USER node

CMD ["node", "src/server.js"]
