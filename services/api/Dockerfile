# P0 Node/Fastify shell. P1 adds Azure CLI and Foundry SDK to this image.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system app && useradd --system --create-home --gid app app \
    && mkdir -p /home/app/.azure \
    && chown -R app:app /home/app/.azure /app
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/package.json ./package.json
ENV AZURE_CONFIG_DIR=/home/app/.azure
USER app
EXPOSE 4000
CMD ["node", "dist/index.js"]
