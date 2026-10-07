# REA (rea-agents) MCP server over authenticated Streamable HTTP, with Ghidra 12.1.4.
# Build with this directory as the context: docker build deploy/http
# Base images are pinned by index digest (linux/amd64 and linux/arm64). The tag is for readers.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS node

FROM eclipse-temurin:21-jdk@sha256:3e3c176ffed168beb42c607be9bc1639b466cf00261a0fb04425562c9d0c5c2b

# Node.js 22 must satisfy the engines range of rea-agents (^22.19.0).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && node --version && npm --version

# Ghidra 12.1.4 from the official release. The digest is the one GitHub publishes
# for the asset. The build fails if the download does not match it.
ARG GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip
ARG GHIDRA_SHA256=ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /tmp/ghidra.zip "$GHIDRA_URL" \
 && echo "$GHIDRA_SHA256  /tmp/ghidra.zip" | sha256sum -c - \
 && unzip -q /tmp/ghidra.zip -d /opt \
 && mv /opt/ghidra_12.1.4_PUBLIC /opt/ghidra \
 && rm /tmp/ghidra.zip

# The base image can ship a user with uid 1000 ("ubuntu"). Replace it with "rea".
RUN (id -u ubuntu >/dev/null 2>&1 && userdel -r ubuntu || true) \
 && useradd -m -u 1000 -U -s /usr/sbin/nologin rea

WORKDIR /app
ENV npm_config_engine_strict=true \
    npm_config_update_notifier=false \
    GHIDRA_INSTALL_DIR=/opt/ghidra
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY serve.mjs serve.test.mjs ./
RUN chown -R rea:rea /app

USER rea
# The build stops here if the entry point breaks against this REA version.
RUN node --test serve.test.mjs

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.REA_MCP_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "serve.mjs"]
