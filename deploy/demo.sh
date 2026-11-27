#!/bin/sh
set -eu

deploy_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$deploy_root"
deploy_env=${DEMO_ENV_FILE:-deploy/.env}
if [ ! -f "$deploy_env" ]; then
  printf '%s\n' 'Missing deploy/.env. Copy deploy/.env.example and fill in your deployment settings.' >&2
  exit 1
fi

if [ "${1:-}" = '--https' ]; then
  shift
  exec docker compose --env-file "$deploy_env" -f compose.production.yml -f compose.https.yml "$@"
fi
exec docker compose --env-file "$deploy_env" -f compose.production.yml "$@"
