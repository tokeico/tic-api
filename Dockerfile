# ---- deps ----
FROM oven/bun:1.4.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime ----
FROM oven/bun:1.4.3
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY reference ./reference
COPY docker-entrypoint.sh ./
RUN chmod 0755 docker-entrypoint.sh
USER bun
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD bun --eval 'const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/health`); process.exit(r.ok && (await r.json()).db === true ? 0 : 1)'
