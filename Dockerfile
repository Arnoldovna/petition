# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# Production image (OVERVIEW.md section 19). Base images are pinned by digest and updated by Dependabot (docker, /).

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Node 25+ no longer bundles corepack. Install exactly the version in package.json#packageManager.
RUN npm install --global pnpm@10.34.9
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch

FROM base AS build
# --ignore-scripts skips the `prepare` hook (lefthook needs git); argon2 loads its bundled prebuilds.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline --ignore-scripts
COPY tsconfig.base.json tsconfig.json tsconfig.build.json ./
# The asset pipeline (fonts, CSS hash, esbuild client bundles, manifest) runs from scripts/ (ADR 0010).
COPY scripts scripts
COPY src src
COPY public public
# Writes dist/: server and tools JS, dist/public/{assets,fonts} with manifest.json, dist/signature-fonts.
RUN pnpm run build

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --offline --ignore-scripts

# Distroless: no shell, no package manager, runs as uid 65532. The files stay owned by root, so the process can read
# but never modify its own code, assets or migrations.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:1d736cf8b5716c07a245301f92717143215d248fd55771ee1936ef4b3302e531 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
# dist/ holds the server, dist/tools (seed, smoke-canvas, erase-user), dist/db/migrate.js, the hashed assets in
# dist/public and the server-side signature fonts in dist/signature-fonts (ADR 0005, 0010).
COPY --from=build /app/dist ./dist
# Committed static files (icons, site.webmanifest, robots.txt).
COPY --from=build /app/public ./public
COPY src/views ./src/views
COPY drizzle ./drizzle
USER nonroot
EXPOSE 3000
CMD ["--enable-source-maps", "dist/server.js"]
