# syntax=docker/dockerfile:1

FROM oven/bun:1-alpine AS build
WORKDIR /src

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY package.json ./

RUN bun build web/index.html --outdir ./build/web --minify \
  && bun build src/server/index.ts --outdir ./build/server --target bun

FROM oven/bun:1-alpine
WORKDIR /app

# su-exec drops privileges in the entrypoint; wget answers the healthcheck.
RUN apk add --no-cache su-exec tzdata wget

COPY --from=build /src/build ./build
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV LIBGEN_PORT=8095 \
    LIBGEN_OUTPUT_DIR=/downloads \
    LIBGEN_CONFIG_DIR=/config \
    LIBGEN_STATIC_DIR=/app/build/web \
    PUID=1000 \
    PGID=1000

VOLUME ["/downloads", "/config"]
EXPOSE 8095

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${LIBGEN_PORT}/api/health" > /dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "/app/build/server/index.js"]
