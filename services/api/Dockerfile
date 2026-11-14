# P7 Gemini experiment: build Node API with its frozen local contracts workspace.
# Azure CLI runtime dependencies remain temporary until the single Gemini worker replaces Foundry.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
# The context is the repository root so @ai-service-agent/contracts resolves
# as an npm workspace package. Never copy .env or local secret files.
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
ENV NODE_ENV=production \
    AZURE_CONFIG_DIR=/home/app/.azure
WORKDIR /app

# Microsoft-maintained, signed Debian 12 apt repository. No credentials in image layers.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
      | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg; \
    chmod 0644 /etc/apt/keyrings/microsoft.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ bookworm main" \
      > /etc/apt/sources.list.d/azure-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends azure-cli; \
    groupadd --system app; \
    useradd --system --create-home --home-dir /home/app --gid app app; \
    install -d -o app -g app -m 0700 /home/app/.azure; \
    chown app:app /app; \
    rm -rf /var/lib/apt/lists/*

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
