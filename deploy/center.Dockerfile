# Build from one public commit. The only runtime payload is the independent installation;
# neither the caller's checkout nor its private ledger enters the image build context.
FROM node:24-bookworm AS build
ARG COMMIT
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN git clone --filter=blob:none https://github.com/FairladyZ625/harness-anything.git /source
WORKDIR /source
RUN git checkout --detach "$COMMIT" && node tools/release-installation.mjs install --root /opt/ha --repository /source --revision "$COMMIT" && ln -s "/opt/ha/versions/$COMMIT" /opt/ha/current

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssl unzip procps && rm -rf /var/lib/apt/lists/* && mkdir -p /var/lib/ha && chown node:node /var/lib/ha
COPY --from=build /opt/ha /opt/ha
USER node
ENV HARNESS_DAEMON_USER_ROOT=/var/lib/ha/user
ENV HARNESS_DAEMON_ID=test-center
VOLUME ["/var/lib/ha"]
WORKDIR /var/lib/ha
ENTRYPOINT ["node", "/opt/ha/current/packages/daemon/dist/index.js", "serve"]
