#!/usr/bin/env bash
# 2026-10-16: deploys a commit (default HEAD) to the monad-dev stack only, on the cloud server:
# `git archive` of the commit into /opt/vivarium/build-<rev> (never /opt/vivarium/src, which the
# judged stacks run from), the image tagged with the commit only (never `latest`), the stack's own
# database and Redis database, and chain.yaml with chain-dev.override.yaml as the
# vivarium-monad-dev project. The stack's keys are in /opt/vivarium/chain-monad-dev.env (600).
# Nothing of the judged stacks is touched.
#
#   scripts/server-deploy-dev.sh [rev]   deploy every service of the stack on one image
#
# Always every service: they share app-net's network namespace, so recreating app-net alone (as a
# one-service deploy does when its image changes) leaves the rest on a namespace that is gone.
set -euo pipefail
SERVER=${VIVARIUM_SERVER:-root@161.35.99.236}
KEY=${VIVARIUM_SSH_KEY:-$HOME/.ssh/vivarium}
REF=${1:-HEAD}
cd "$(dirname "$0")/.."
REV=$(git rev-parse --short "$REF")
ssh_() { ssh -i "$KEY" -o BatchMode=yes "$SERVER" "$@"; }

echo "dev deploy: sending $REV"
git archive --format=tar "$REV" | ssh_ "set -e; rm -rf /opt/vivarium/build-$REV; mkdir -p /opt/vivarium/build-$REV
  tar -x -C /opt/vivarium/build-$REV; echo '$REV' > /opt/vivarium/build-$REV/REVISION"
echo "dev deploy: building vivarium-backend:$REV (no latest)"
ssh_ "set -e; cd /opt/vivarium/build-$REV
  docker image inspect vivarium-backend:$REV >/dev/null 2>&1 || docker build -q -t vivarium-backend:$REV -f infra/server/Dockerfile . >/dev/null
  test -f /opt/vivarium/chain-monad-dev.env || { echo 'chain-monad-dev.env is missing' >&2; exit 1; }
  docker exec vivarium-postgres-1 psql -U alpha -d alpha_agents -tAc \"select 1 from pg_database where datname = 'alpha_agents_monad_dev'\" | grep -q 1 \
    || docker exec vivarium-postgres-1 psql -U alpha -d alpha_agents -qc 'create database alpha_agents_monad_dev'
  CHAIN=monad-dev DB=alpha_agents_monad_dev REDIS_DB=5 SITE=https://vivarium-dev.vercel.app MARKET_CHAIN=monad VIVARIUM_CHAIN_REVISION=$REV \
    docker compose --env-file /opt/vivarium/.env -f infra/server/chain.yaml -f infra/server/chain-dev.override.yaml \
    up -d --remove-orphans --wait --wait-timeout 300
  CHAIN=monad-dev DB=alpha_agents_monad_dev REDIS_DB=5 SITE=https://vivarium-dev.vercel.app \
    docker compose --env-file /opt/vivarium/.env -f infra/server/chain.yaml -f infra/server/chain-dev.override.yaml \
    ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'"
echo "dev deploy: $REV on vivarium-monad-dev; API on the server's 127.0.0.1:4410 (tunnel: ssh -L 4410:127.0.0.1:4410)"
