#!/usr/bin/env bash
# Stops Brain/BFF/Web started by dev-up.sh. Postgres is left running by default
# (it's a persistent dev DB, not something to tear down between sessions) —
# pass --with-db to also stop the Postgres container.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT_DIR/.dev/pids"

c_green='\033[0;32m'; c_yellow='\033[0;33m'; c_reset='\033[0m'
log()  { echo -e "${c_green}==>${c_reset} $1"; }
warn() { echo -e "${c_yellow}==>${c_reset} $1"; }

stop_pidfile() {
  local name="$1" pidfile="$PID_DIR/$1.pid"
  if [ -f "$pidfile" ]; then
    local pid; pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && log "Stopped $name (pid $pid)"
    else
      warn "$name pidfile present but process $pid not running"
    fi
    rm -f "$pidfile"
  else
    warn "No pidfile for $name — nothing to stop (was it started outside dev-up.sh?)"
  fi
}

stop_pidfile web
stop_pidfile bff
stop_pidfile brain

if [ "${1:-}" = "--with-db" ]; then
  log "Stopping Postgres container..."
  if docker compose version >/dev/null 2>&1; then (cd "$ROOT_DIR" && docker compose stop postgres);
  else (cd "$ROOT_DIR" && docker-compose stop postgres); fi
else
  warn "Postgres left running (pass --with-db to also stop it)."
fi
