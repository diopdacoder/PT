# syntax=docker/dockerfile:1.6
# Multi-stage build keeps the final image small.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app

# Drop privileges.
RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app . .

ENV NODE_ENV=production
USER app
EXPOSE 3000

CMD ["node", "index.js"]
