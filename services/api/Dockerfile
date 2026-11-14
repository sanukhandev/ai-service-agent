# Gemini experimental Node runtime: no Azure CLI, Python or embedding service.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json ./package.json
COPY services/api/package.json ./services/api/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN npm install --ignore-scripts --no-audit --no-fund
COPY packages/contracts/gemini-v1.ts ./packages/contracts/gemini-v1.ts
COPY packages/contracts/tsconfig.build.json ./packages/contracts/tsconfig.build.json
COPY services/api/tsconfig.json ./services/api/tsconfig.json
COPY services/api/src/ ./services/api/src/
RUN npm run build --workspace @ai-service-agent/contracts \
 && npm run build --workspace @ai-service-agent/api \
 && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system app && useradd --system --create-home --home-dir /home/app --gid app app
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/services/api/dist ./services/api/dist
COPY --from=builder --chown=app:app /app/services/api/package.json ./services/api/package.json
COPY --from=builder --chown=app:app /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder --chown=app:app /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=builder --chown=app:app /app/package.json ./package.json
WORKDIR /app/services/api
USER app
EXPOSE 4000
CMD ["node", "dist/index.js"]
