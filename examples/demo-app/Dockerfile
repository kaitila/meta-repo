# Production image: runtime dependencies only, runs as the non-root `bun` user.
FROM oven/bun:1.3.5 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
# Dev dependencies (test-kit, docs-check, drizzle-kit, typescript) stay out of the image.
RUN bun install --production --ignore-scripts

FROM oven/bun:1.3.5
WORKDIR /app
ENV NODE_ENV=production PORT=3000
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun docker/entrypoint.sh ./docker/entrypoint.sh
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz'); process.exit(r.ok ? 0 : 1)"
ENTRYPOINT ["sh", "docker/entrypoint.sh"]
