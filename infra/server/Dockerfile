# The testnet backend's one image (docs/HOSTING.md): every service runs from it with its own
# command. Built on the server from `git archive` of a commit, so nothing outside git (no .env,
# no .dev, no clones) is ever in the build context. Node runs the TypeScript sources directly.
FROM node:22.23.1-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
# The orchestrator's sandbox gate tunnel (services/orchestrator/src/tunnel.ts), outbound only.
ARG CLOUDFLARED_VERSION=2026.9.3
RUN curl -fsSL -o /usr/local/bin/cloudflared \
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
  && chmod +x /usr/local/bin/cloudflared \
  && cloudflared --version
# anvil: the token registry screens tokens on a latest-block fork it starts itself, on testnet
# too (packages/devenv/src/test-fork.ts). The version is the repo's .foundry-version.
ARG FOUNDRY_VERSION=v1.8.3
RUN curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C /usr/local/bin anvil \
  && anvil --version
RUN corepack enable && corepack prepare pnpm@9.14.4 --activate

WORKDIR /app
COPY . .
# --ignore-scripts: the git hook installer and the asset tooling's native builds are not needed
# to run the services.
RUN pnpm install --frozen-lockfile --ignore-scripts \
  && mkdir -p /app/.dev
ENV NODE_ENV=production FORCE_COLOR=0 NO_COLOR=1
