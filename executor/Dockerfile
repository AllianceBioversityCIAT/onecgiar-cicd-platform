# @akili-spec changes/cicd-executor-poc design §4.2, DD-01, DD-05, DD-15, DD-16, DD-19; requirements NFR-01, NFR-08
#
# Boundary (NFR-01): this image builds and runs ONLY the Executor itself.
# It MUST NOT contain application build toolchains (npm/pnpm/yarn/corepack,
# maven/gradle/java, python build chains), the docker CLI/daemon, or a
# mounted docker.sock. Multi-stage is used solely to compile and install the
# Executor's OWN TypeScript and production dependencies; it never compiles
# or installs application code.
#
# The `builder` and `deps` stages are allowed to use npm (they produce
# build/install artifacts, they are not the shipped image). The `runtime`
# stage — the final stage, the one that is actually shipped and run — never
# invokes npm/pnpm/yarn/corepack, and explicitly removes those binaries
# inherited from the node base image before anything else runs as a
# non-root user.
#
# Statically checked by test/support/dockerfile-boundary-scanner.ts, with
# negative fixtures per rule in test/unit/dockerfile-boundary-scanner.test.ts
# proving each rule can fail on its own. The scanner is a best-effort
# pre-check; the authoritative gate is scripts/inspect-image.mjs (`npm run
# inspect:image`), which builds this image and runs `find`/`id` inside it.
# That real check is DEFERRED here — no Docker daemon is reachable in this
# environment — and reports a distinct non-zero exit + "DEFERRED: docker
# daemon unavailable" rather than ever reporting PASS in that case.
#
# node:22-slim also ships yarn under /opt/yarn-v<version> with symlinks
# into /usr/local/bin; removing only the symlinks leaves the toolchain on
# disk, so /opt/yarn-* is removed below too.
#
# TODO(T-01 follow-up): pin node:22-slim by digest (`node@sha256:...`) once a
# readable source confirms the current digest; not fabricated here.
#
# BUILD CONTEXT (T-03, design DD-19): this Dockerfile is built with the
# PLATFORM REPO ROOT as context — `docker build -f executor/Dockerfile .`
# from the repo root, exactly what scripts/inspect-image.mjs does by default
# (resolveBuildContext) — NOT `executor/`. That is what lets this stage COPY
# `deployment-definitions/`, `schemas/` and `deploy-scripts/` (siblings of
# `executor/`, outside it) straight into the image: DD-19 "deployment-
# definitions/, schemas/ and deploy-scripts/ are copied into the image at
# build time". All COPY sources below are therefore repo-root-relative
# (`executor/...` for the Executor's own code). The repo-root `.dockerignore`
# (not `executor/.dockerignore`, which is a separate file only used by the
# executor-root-context falsifier fixtures) keeps local-only files out of
# this build. `BundledDefinitionSource` finds these directories at runtime by
# walking up from its own module location until it finds both
# `deployment-definitions/` and `schemas/` — they are copied to the image's
# filesystem root below so that walk-up succeeds unchanged from dev.
#
# DEFINITION_REF (DD-19: "definitionRef = the platform repo's commit,
# injected at build time"; FR-01: definitionRef recorded per execution): pass
# the platform repo commit at build time with
# `--build-arg DEFINITION_REF=$(git rev-parse HEAD)`. Omitting it leaves
# CICD_DEFINITION_REF empty; because this runtime stage sets NODE_ENV=production,
# BundledDefinitionSource then REFUSES TO START (requireInjectedRef defaults
# to NODE_ENV==="production") instead of silently falling back to a dev
# sentinel — a production container must never run with an unverified
# definitionRef.
#
# CICD_DEFINITIONS_ROOT: set below to the image filesystem root, where
# deployment-definitions/, schemas/ and deploy-scripts/ are copied (DD-19).
# BundledDefinitionSource reads this explicitly rather than relying on its
# walk-up search, which remains only as a dev-local fallback when the env
# var is absent.

# ---- builder: compiles the Executor's own TypeScript only (DD-15) ----
FROM node:22-slim AS builder

WORKDIR /build

COPY executor/package.json executor/package-lock.json executor/tsconfig.json ./
RUN npm ci

COPY executor/src ./src
RUN npm run build

# ---- deps: installs the Executor's OWN production dependencies only ----
FROM node:22-slim AS deps

WORKDIR /build

COPY executor/package.json executor/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---- runtime: final, shipped stage. No npm/pnpm/yarn/corepack survive. ----
FROM node:22-slim AS runtime

ARG DEFINITION_REF=""

# git: needed by git-cli-client (design §4.2). No other OS toolchain.
# No docker.io/docker-ce-cli, no maven/openjdk/gradle, no python build chains.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system executor \
    && useradd --system --gid executor --home-dir /app --no-create-home executor

WORKDIR /app

COPY --chown=executor:executor executor/package.json ./package.json
COPY --from=deps --chown=executor:executor /build/node_modules ./node_modules
COPY --from=builder --chown=executor:executor /build/dist ./dist

# DD-19 (PoC simplification): deployment-definitions/, schemas/ and
# deploy-scripts/ are packaged into the image at build time, at the image
# filesystem ROOT — a sibling of /app. BundledDefinitionSource is told this
# explicitly via CICD_DEFINITIONS_ROOT=/ below (its dev-only walk-up, which
# looks for an ancestor directory containing both deployment-definitions/ and
# schemas/, is not relied upon here).
COPY --chown=executor:executor deployment-definitions /deployment-definitions
COPY --chown=executor:executor schemas /schemas
COPY --chown=executor:executor deploy-scripts /deploy-scripts

# Remove the Node package managers shipped by the base image. The runtime
# stage only ever RUNs `node`; npm/npx/corepack/yarn are not application
# code and must not be present for the (deferred) image inspection.
RUN rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx \
      /opt/yarn-*

USER executor

ENV CICD_DEFINITION_REF=${DEFINITION_REF}
ENV CICD_DEFINITIONS_ROOT=/
ENV NODE_ENV=production

CMD ["node", "dist/src/main/index.js"]
