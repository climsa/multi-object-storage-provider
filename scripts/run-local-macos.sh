#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${ROOT_DIR}/.local/run"
LOG_DIR="${ROOT_DIR}/.local/logs"
mkdir -p "${RUN_DIR}" "${LOG_DIR}"
chmod 700 "${RUN_DIR}" "${LOG_DIR}"
cd "${ROOT_DIR}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing command: $1" >&2
    exit 1
  fi
}

require_command brew
require_command node
require_command npm
require_command curl
require_command minio
require_command redis-cli

PG_ISREADY_BIN="$(command -v pg_isready || true)"
if [[ -z "${PG_ISREADY_BIN}" && -x "/opt/homebrew/opt/postgresql@16/bin/pg_isready" ]]; then
  PG_ISREADY_BIN="/opt/homebrew/opt/postgresql@16/bin/pg_isready"
fi
if [[ -z "${PG_ISREADY_BIN}" ]]; then
  echo "Missing pg_isready. Install PostgreSQL client tools, but do not create another PostgreSQL server." >&2
  exit 1
fi

if ! "${PG_ISREADY_BIN}" >/dev/null 2>&1; then
  echo "PostgreSQL is not accepting connections. Start the existing PostgreSQL instance first." >&2
  exit 1
fi

DATABASE_SECRET="${ROOT_DIR}/.local/secrets/database-url"
for secret_file in "${DATABASE_SECRET}" "${ROOT_DIR}/.local/secrets/auth-signing-key" "${ROOT_DIR}/.local/secrets/provider-kek"; do
  if [[ ! -f "${secret_file}" ]]; then
    echo "Missing local secret file: ${secret_file}" >&2
    exit 1
  fi
  mode="$(stat -f '%Lp' "${secret_file}")"
  if [[ "${mode}" != "600" ]]; then
    echo "Secret file must have mode 600: ${secret_file}" >&2
    exit 1
  fi
done

echo "Preparing the existing PostgreSQL database..."
npm run secrets:init
npm run db:generate
npm run db:deploy

REDIS_LAST_RESTART=0
ensure_redis() {
  if redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q '^PONG$'; then
    return 0
  fi

  now="$(date +%s)"
  if (( now - REDIS_LAST_RESTART < 10 )); then
    return 1
  fi
  REDIS_LAST_RESTART="${now}"
  echo "Starting Redis through Homebrew..."
  brew services start redis >/dev/null 2>&1 || brew services restart redis >/dev/null 2>&1 || true
  for _ in $(seq 1 15); do
    if redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q '^PONG$'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if ! ensure_redis; then
  echo "Redis did not become ready. Inspect: /opt/homebrew/var/log/redis.log" >&2
  exit 1
fi

API_PID=""
WORKER_PID=""
WEB_PID=""
MINIO_PID=""
MINIO_MANAGED=0

cleanup() {
  set +e
  for pid in "${API_PID}" "${WORKER_PID}" "${WEB_PID}"; do
    [[ -n "${pid}" ]] && kill "${pid}" 2>/dev/null || true
  done
  [[ "${MINIO_MANAGED}" == "1" && -n "${MINIO_PID}" ]] && kill "${MINIO_PID}" 2>/dev/null || true
  sleep 1
  for pid in "${API_PID}" "${WORKER_PID}" "${WEB_PID}"; do
    [[ -n "${pid}" ]] && kill -9 "${pid}" 2>/dev/null || true
  done
  [[ "${MINIO_MANAGED}" == "1" && -n "${MINIO_PID}" ]] && kill -9 "${MINIO_PID}" 2>/dev/null || true
}
on_signal() {
  cleanup
  exit 130
}
trap cleanup EXIT
trap on_signal INT TERM

wait_for_url() {
  url="$1"
  label="$2"
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "${url}" >/dev/null 2>&1; then
      echo "${label} is ready: ${url}"
      return 0
    fi
    sleep 1
  done
  echo "${label} did not become ready: ${url}" >&2
  return 1
}

start_minio() {
  echo "Starting MinIO..."
  MINIO_ROOT_USER="${MINIO_ROOT_USER}" MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD}" \
    minio server "${ROOT_DIR}/.local/minio-data" \
      --address 127.0.0.1:9000 \
      --console-address 127.0.0.1:9001 \
      >"${LOG_DIR}/minio.log" 2>&1 &
  MINIO_PID=$!
  MINIO_MANAGED=1
  wait_for_url http://127.0.0.1:9000/minio/health/live "MinIO"
}

if ! curl -fsS --max-time 2 http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then
  echo "MinIO is not running. Enter the credentials for this local MinIO data directory."
  read -r -p "MinIO root user: " MINIO_ROOT_USER
  read -r -s -p "MinIO root password: " MINIO_ROOT_PASSWORD
  echo
  if [[ -z "${MINIO_ROOT_USER}" || -z "${MINIO_ROOT_PASSWORD}" ]]; then
    echo "MinIO credentials cannot be empty." >&2
    exit 1
  fi
  start_minio
else
  echo "MinIO is already running."
fi

export NODE_ENV=development
export MOSP_REDIS_URL="redis://127.0.0.1:6379"
export MOSP_PROVIDER_ALLOW_HTTP=true
export MOSP_PROVIDER_ALLOW_PRIVATE_NETWORK=true
# Keep local MinIO available while allowing normal public S3-compatible HTTPS
# endpoints on 443. The HTTP/private flags remain development-only settings;
# production deployments must use the stricter public HTTPS policy.
export MOSP_PROVIDER_ALLOWED_PORTS=80,443,9000
export MOSP_ALLOWED_ORIGINS="http://localhost:3000,http://127.0.0.1:3000"
export MOSP_API_ORIGIN="http://127.0.0.1:4000"

echo "Starting API, worker, and web..."
npm run dev:api >"${LOG_DIR}/api.log" 2>&1 &
API_PID="$!"
npm run dev --workspace @mosp/worker >"${LOG_DIR}/worker.log" 2>&1 &
WORKER_PID="$!"
npm run dev:web >"${LOG_DIR}/web.log" 2>&1 &
WEB_PID="$!"

wait_for_url http://127.0.0.1:4000/healthz "API"
wait_for_url http://127.0.0.1:3000 "Web"

cat <<EOF

Local MOSP stack is running.
  Web:    http://127.0.0.1:3000
  API:    http://127.0.0.1:4000
  MinIO:  http://127.0.0.1:9001
  Redis:  redis://127.0.0.1:6379

Logs:
  ${LOG_DIR}/api.log
  ${LOG_DIR}/worker.log
  ${LOG_DIR}/web.log
  ${LOG_DIR}/minio.log

Press Ctrl-C to stop API, worker, web, and MinIO. PostgreSQL and Redis remain
managed by their Homebrew services. If API, worker, web, or script-managed
MinIO exits, only that service is restarted automatically.
EOF

while true; do
  ensure_redis || true
  if ! kill -0 "${API_PID}" 2>/dev/null; then
    echo "API exited; restarting it."
    npm run dev:api >>"${LOG_DIR}/api.log" 2>&1 &
    API_PID="$!"
  fi
  if ! kill -0 "${WORKER_PID}" 2>/dev/null; then
    echo "Worker exited; restarting it."
    npm run dev --workspace @mosp/worker >>"${LOG_DIR}/worker.log" 2>&1 &
    WORKER_PID="$!"
  fi
  if ! kill -0 "${WEB_PID}" 2>/dev/null; then
    echo "Web exited; restarting it."
    npm run dev:web >>"${LOG_DIR}/web.log" 2>&1 &
    WEB_PID="$!"
  fi
  if [[ "${MINIO_MANAGED}" == "1" ]] && ! kill -0 "${MINIO_PID}" 2>/dev/null; then
    echo "MinIO exited; restarting it."
    start_minio
  fi
  sleep 2
done
