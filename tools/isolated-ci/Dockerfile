# Runtime versions observed in rewrite-ci run 38093101476. No project source,
# credentials or npm cache is baked into these test-only images.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
FROM ${NODE_IMAGE} AS node
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55 AS system
ENV DEBIAN_FRONTEND=noninteractive
# Ubuntu's signed archive snapshot locks transitive OS packages too.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates=20260601~24.04.1 \
    && apt-get update --snapshot 20261010T000000Z \
    && apt-get install -y --no-install-recommends --snapshot 20261010T000000Z \
       build-essential ca-certificates curl git openssl procps python3 rsync xz-utils \
       openjdk-21-jre-headless postgresql xvfb libglib2.0-0t64 libnss3 libatk-bridge2.0-0t64 libgtk-3-0t64 libasound2t64 \
    && dpkg-query -W > /usr/local/share/harness-ci-packages.txt \
    && apt-get clean
# Pin the runner's Git rather than Ubuntu's older distribution build. The digest
# checks an external download at its ingestion boundary (kernel.org sha256sums.asc).
FROM system AS git
RUN apt-get install -y --no-install-recommends --snapshot 20261010T000000Z \
       libcurl4-openssl-dev libssl-dev libexpat1-dev zlib1g-dev gettext cargo
RUN curl --fail --location https://www.kernel.org/pub/software/scm/git/git-2.55.0.tar.xz -o /tmp/git.tar.xz \
    && echo "457fdb04dc8728e007d4688695e6912e6f680727920f2a40bf11eacc17505357  /tmp/git.tar.xz" | sha256sum --check \
    && tar -xJf /tmp/git.tar.xz -C /tmp
RUN make -C /tmp/git-2.55.0 -j2 prefix=/usr/local DESTDIR=/git-install NO_TCLTK=YesPlease install
FROM system
COPY --from=git /git-install/usr/local/ /usr/local/
COPY --from=node /usr/local/ /usr/local/
ENV LANG=C.UTF-8 TZ=Etc/UTC
# Keep Electron postinstall on the reachable domestic mirror in the server facility.
ENV ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
# The runner UID must equal the dedicated host account's UID: the bind mount is owned by it.
ARG RUNNER_UID=1001
RUN git config --system init.defaultBranch main \
    && useradd --create-home --uid ${RUNNER_UID} runner \
    && mkdir /workspace && chown runner:runner /workspace
# Managed PostgreSQL refuses root, as it does on the GitHub hosted runner.
USER runner
WORKDIR /workspace
ENV npm_package_config_node_gyp_nodedir=/usr/local
CMD ["node", "--version"]
