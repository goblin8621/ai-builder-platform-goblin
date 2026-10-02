#!/usr/bin/env bash
# One-shot local dev stack launcher: Postgres(Docker) -> Brain(FastAPI) -> BFF(Fastify) -> Web(Next.js).
# Idempotent: safe to re-run — skips anything already installed/running on its port.
set -euo pipefail

# Podman Desktop (macOS) installs its CLI here but doesn't always put it on
# PATH for non-interactive shells (only the `docker=podman` shell alias,
# which a script doesn't inherit) — add it so container_cli() below can
# actually find the binary instead of silently failing to look at all.
export PATH="$PATH:/opt/podman/bin"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT_DIR/.dev/pids"
LOG_DIR="$ROOT_DIR/.dev/logs"
mkdir -p "$PID_DIR" "$LOG_DIR"

BRAIN_PORT=8000
BFF_PORT=4000
WEB_PORT=3000

c_green='\033[0;32m'; c_yellow='\033[0;33m'; c_red='\033[0;31m'; c_reset='\033[0m'
log()  { echo -e "${c_green}==>${c_reset} $1"; }
warn() { echo -e "${c_yellow}==>${c_reset} $1"; }
err()  { echo -e "${c_red}==>${c_reset} $1"; }

port_listening() {
  lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null | grep -q ":$1 (LISTEN)"
}

wait_for_http() {
  local url="$1" name="$2" tries="${3:-30}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 1
  done
  err "$name did not become healthy at $url within ${tries}s — check $LOG_DIR"
  return 1
}

compose() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then docker compose "$@";
  else docker-compose "$@"; fi
}

# Container CLI for `exec` (psql fallback) — this environment aliases `docker`
# to podman interactively, but that alias doesn't reach a non-interactive
# bash script, so probe for real binaries instead.
container_cli() {
  if command -v podman >/dev/null 2>&1; then echo podman;
  elif command -v docker >/dev/null 2>&1; then echo docker;
  else err "Neither podman nor docker found on PATH — install psql locally or one of these."; exit 1; fi
}

# ---------- 1. Postgres ----------
log "Starting Postgres (Docker Compose)..."
(cd "$ROOT_DIR" && compose up -d postgres)

log "Waiting for Postgres healthcheck..."
for _ in $(seq 1 30); do
  status="$(cd "$ROOT_DIR" && compose ps postgres --format json 2>/dev/null | grep -o '"Health":"[a-z]*"' | head -1 | cut -d'"' -f4 || true)"
  [ "$status" = "healthy" ] && break
  sleep 1
done
[ "$status" = "healthy" ] || warn "Postgres health status unclear (got '$status') — continuing, migrations will fail loudly if it's not actually ready."

# ---------- 2. Migrations + seed (idempotent: IF NOT EXISTS / ON CONFLICT DO NOTHING) ----------
# Applied to BOTH the real dev DB and a separate ai_builder_platform_test DB
# — `bff/vitest.config.ts` points `npm test` at the _test one by default, so
# running the automated suite never fills the Web UI's "My Skills" with
# leftover test fixtures (discovered the hard way: it used to).
log "Applying DB migrations + seed (dev + test DB)..."
apply_sql() {
  local dbname="$1" file="$2"
  if command -v psql >/dev/null 2>&1; then
    psql "postgresql://ai_builder:ai_builder@localhost:5477/$dbname" -v ON_ERROR_STOP=1 -f "$file"
  else
    "$(container_cli)" exec -i ai-builder-platform-postgres psql -U ai_builder -d "$dbname" < "$file"
  fi
}
ensure_test_db() {
  if command -v psql >/dev/null 2>&1; then
    psql "postgresql://ai_builder:ai_builder@localhost:5477/ai_builder_platform" -v ON_ERROR_STOP=1 -c \
      "SELECT 1 FROM pg_database WHERE datname='ai_builder_platform_test'" | grep -q 1 || \
      psql "postgresql://ai_builder:ai_builder@localhost:5477/ai_builder_platform" -c "CREATE DATABASE ai_builder_platform_test"
  else
    local cli; cli="$(container_cli)"
    "$cli" exec ai-builder-platform-postgres psql -U ai_builder -d ai_builder_platform -c \
      "SELECT 1 FROM pg_database WHERE datname='ai_builder_platform_test'" | grep -q 1 || \
      "$cli" exec ai-builder-platform-postgres psql -U ai_builder -d ai_builder_platform -c "CREATE DATABASE ai_builder_platform_test"
  fi
}
ensure_test_db
for db in ai_builder_platform ai_builder_platform_test; do
  apply_sql "$db" "$ROOT_DIR/db/migrations/001_init.sql"
  apply_sql "$db" "$ROOT_DIR/db/migrations/002_skill_registry.sql"
  apply_sql "$db" "$ROOT_DIR/db/seeds/001_seed_workspace.sql"
done

# ---------- 3. Brain (FastAPI) ----------
if port_listening "$BRAIN_PORT"; then
  warn "Brain already listening on $BRAIN_PORT — skipping start."
else
  log "Preparing Brain venv..."
  cd "$ROOT_DIR/brain"
  if [ ! -x ".venv/bin/uvicorn" ]; then
    python3.11 -m venv .venv
    .venv/bin/pip install -q -r requirements.txt
  fi
  log "Starting Brain on :$BRAIN_PORT..."
  nohup .venv/bin/uvicorn app.main:app --port "$BRAIN_PORT" > "$LOG_DIR/brain.log" 2>&1 &
  echo $! > "$PID_DIR/brain.pid"
  cd "$ROOT_DIR"
fi
wait_for_http "http://localhost:$BRAIN_PORT/health" "Brain"

# ---------- 4. BFF (Fastify) ----------
if port_listening "$BFF_PORT"; then
  warn "BFF already listening on $BFF_PORT — skipping start."
else
  log "Preparing BFF deps..."
  cd "$ROOT_DIR/bff"
  [ -d node_modules ] || npm install --silent
  log "Starting BFF on :$BFF_PORT..."
  WEB_ORIGINS="http://localhost:$WEB_PORT" nohup npm run dev > "$LOG_DIR/bff.log" 2>&1 &
  echo $! > "$PID_DIR/bff.pid"
  cd "$ROOT_DIR"
fi
wait_for_http "http://localhost:$BFF_PORT/health" "BFF"

# ---------- 5. Web (Next.js) ----------
if port_listening "$WEB_PORT"; then
  warn "Web already listening on $WEB_PORT — skipping start."
else
  log "Preparing Web deps..."
  cd "$ROOT_DIR/web"
  [ -d node_modules ] || npm install --silent
  log "Starting Web on :$WEB_PORT..."
  NEXT_PUBLIC_BFF_URL="http://localhost:$BFF_PORT" nohup npm run dev > "$LOG_DIR/web.log" 2>&1 &
  echo $! > "$PID_DIR/web.pid"
  cd "$ROOT_DIR"
fi
wait_for_http "http://localhost:$WEB_PORT" "Web"

echo
log "All services up:"
echo "    Web    http://localhost:$WEB_PORT/skills"
echo "    BFF    http://localhost:$BFF_PORT/health"
echo "    Brain  http://localhost:$BRAIN_PORT/health"
echo "    Logs   $LOG_DIR/{brain,bff,web}.log"
echo
echo "  Stop everything:  scripts/dev-down.sh"
