# ============================================================================
# Production image — multi-stage.
#
# Stage 1 builds with dev dependencies; stage 2 ships only what runtime needs.
# Runs as a non-root user, and declares a HEALTHCHECK so the platform can
# restart a wedged container rather than leaving it serving errors.
# ============================================================================

# ---- Stage 1: build --------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# Prisma client must be generated before tsc — the build imports its types.
RUN npx prisma generate

COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies, keeping the generated Prisma client.
RUN npm prune --omit=dev


# ---- Stage 2: runtime ------------------------------------------------------
FROM node:20-alpine AS runtime

# dumb-init gives us correct PID-1 signal handling, so SIGTERM reaches Node and
# the graceful-shutdown path actually runs.
# wget is used by HEALTHCHECK.
RUN apk add --no-cache dumb-init wget

ENV NODE_ENV=production \
    PORT=4000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# node:alpine already ships an unprivileged `node` user (uid 1000).
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/prisma ./prisma
COPY --chown=node:node package*.json ./

USER node

EXPOSE 4000

# Readiness probe: checks Postgres and Redis, not just "is the process alive".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health/ready || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
