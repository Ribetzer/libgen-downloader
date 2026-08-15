#!/bin/sh
set -e

# Downloads have to be owned by the user that reads them off the NAS share, not
# by root, so the container adopts the ids it is given.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ -n "${TZ}" ] && [ -f "/usr/share/zoneinfo/${TZ}" ]; then
  cp "/usr/share/zoneinfo/${TZ}" /etc/localtime
  echo "${TZ}" > /etc/timezone
fi

if ! getent group libgen > /dev/null 2>&1; then
  addgroup -g "${PGID}" libgen 2>/dev/null || addgroup libgen
fi

if ! id libgen > /dev/null 2>&1; then
  adduser -D -H -u "${PUID}" -G libgen libgen 2>/dev/null || adduser -D -H -G libgen libgen
fi

mkdir -p "${LIBGEN_OUTPUT_DIR:-/downloads}" "${LIBGEN_CONFIG_DIR:-/config}"

# Only the config directory is taken over wholesale; the download share may hold
# a large existing library, so just make sure it is writable.
chown -R "${PUID}:${PGID}" "${LIBGEN_CONFIG_DIR:-/config}" 2>/dev/null || true
chown "${PUID}:${PGID}" "${LIBGEN_OUTPUT_DIR:-/downloads}" 2>/dev/null || true

echo "libgen-downloader starting as ${PUID}:${PGID}"

exec su-exec "${PUID}:${PGID}" "$@"
