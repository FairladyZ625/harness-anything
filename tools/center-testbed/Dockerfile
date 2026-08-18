# PLT-Center full-stack testbed image: harness-anything source + built CLI +
# the testbed scripts. Mirrors the coldstart benchmark image recipe
# (context/benchmark/coldstart/Dockerfile): node:24-bookworm-slim, full npm ci,
# `npm run build -w @harness-anything/cli`. Credentials are never baked in —
# the GitLab token arrives as runtime env, fleet TLS material is minted by the
# seed bootstrap into a shared volume.

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates git openssl procps python3 \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system init.defaultBranch main \
    && git config --system safe.directory /opt/harness-anything

WORKDIR /opt/harness-anything

COPY package.json package-lock.json tsconfig.json ./
COPY packages/ packages/

# electron is a GUI devDependency; the testbed never launches it, so the
# ~100MB binary download is skipped while the package itself still installs.
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund \
    && npm run build -w @harness-anything/cli

COPY tools/center-testbed/ /opt/testbed/

# `ha` prefers the built dist and falls back to source for source-tree images.
RUN printf '#!/bin/sh\nif [ -f /opt/harness-anything/packages/cli/dist/cli/src/index.js ]; then\n  exec node /opt/harness-anything/packages/cli/dist/cli/src/index.js "$@"\nelse\n  exec node /opt/harness-anything/packages/cli/src/index.ts "$@"\nfi\n' > /usr/local/bin/ha \
    && chmod +x /usr/local/bin/ha \
    && ha --version

WORKDIR /data
