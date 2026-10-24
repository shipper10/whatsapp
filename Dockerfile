FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json drizzle.config.ts ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm i --no-save tsx
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
USER node
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
