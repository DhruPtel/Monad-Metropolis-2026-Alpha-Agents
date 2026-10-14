#!/usr/bin/env bash
# Deploys a commit to the cloud server (docs/HOSTING.md): `git archive` of the commit (default
# HEAD) is unpacked into /opt/vivarium/src, the image is built there and tagged with the commit,
# and every service whose image or settings changed is recreated, then waited on until healthy.
# Only committed files travel; .env, .dev and anything untracked never leave the laptop.
#
#   scripts/server-deploy.sh            deploy HEAD
#   scripts/server-deploy.sh 6f1dbbc    deploy that commit
#   scripts/server-deploy.sh HEAD base-sepolia arbitrum-sepolia
#                                       also (re)start those chains' stacks (CO-U1, chain.yaml)
#
# The Monad testnet stack (compose.yaml, the Metropolis site's) runs the image VIVARIUM_REVISION
# names in /opt/vivarium/.env when it is set, so a deploy of newer code never changes it.
set -euo pipefail
SERVER=${VIVARIUM_SERVER:-root@161.35.99.236}
KEY=${VIVARIUM_SSH_KEY:-$HOME/.ssh/vivarium}
REF=${1:-HEAD}
shift || true
CHAINS=("$@")
cd "$(dirname "$0")/.."
REV=$(git rev-parse --short "$REF")
[ -n "$(git status --porcelain --untracked-files=no)" ] && [ "$REF" = HEAD ] &&
  echo "note: uncommitted changes are not deployed; only $REV is"
ssh_() { ssh -i "$KEY" -o BatchMode=yes "$SERVER" "$@"; }

echo "deploy: sending $REV"
git archive --format=tar "$REV" | ssh_ "set -e; rm -rf /opt/vivarium/src.new; mkdir -p /opt/vivarium/src.new
  tar -x -C /opt/vivarium/src.new; echo '$REV' > /opt/vivarium/src.new/REVISION
  mkdir -p /opt/vivarium/src; rsync -a --delete /opt/vivarium/src.new/ /opt/vivarium/src/; rm -rf /opt/vivarium/src.new"
echo "deploy: building vivarium-backend:$REV on the server"
ssh_ "set -e; cd /opt/vivarium/src
  docker build -q -t vivarium-backend:$REV -t vivarium-backend:latest -f infra/server/Dockerfile . >/dev/null
  install -m 644 infra/server/systemd/*.service infra/server/systemd/*.timer /etc/systemd/system/
  systemctl daemon-reload
  docker compose --env-file /opt/vivarium/.env -f infra/server/compose.yaml up -d --remove-orphans --wait --wait-timeout 300
  docker compose --env-file /opt/vivarium/.env -f infra/server/compose.yaml restart caddy >/dev/null
  docker compose --env-file /opt/vivarium/.env -f infra/server/compose.yaml ps --format 'table {{.Service}}\t{{.Status}}'"
for chain in "${CHAINS[@]}"; do
  case "$chain" in
    base-sepolia) db=alpha_agents_base_sepolia redis=2 site=https://vivarium-base.vercel.app ;;
    arbitrum-sepolia) db=alpha_agents_arbitrum_sepolia redis=3 site=https://vivarium-arbitrum.vercel.app ;;
    monad) db=alpha_agents_monad redis=4 site=https://vivarium-testnet.vercel.app ;;
    *) echo "deploy: unknown chain $chain" >&2; exit 2 ;;
  esac
  market=base
  [ "$chain" = monad ] && market=monad
  echo "deploy: the $chain stack ($db)"
  ssh_ "set -e; cd /opt/vivarium/src
    dc() { docker compose --env-file /opt/vivarium/.env -f infra/server/compose.yaml \"\$@\"; }
    dc exec -T postgres psql -U alpha -d alpha_agents -tAc \"select 1 from pg_database where datname = '$db'\" | grep -q 1 \
      || dc exec -T postgres psql -U alpha -d alpha_agents -qc 'create database $db'
    CHAIN=$chain DB=$db REDIS_DB=$redis SITE=$site MARKET_CHAIN=$market VIVARIUM_CHAIN_REVISION=$REV \
      docker compose --env-file /opt/vivarium/.env -f infra/server/chain.yaml up -d --remove-orphans --wait --wait-timeout 300
    CHAIN=$chain DB=$db REDIS_DB=$redis SITE=$site \
      docker compose --env-file /opt/vivarium/.env -f infra/server/chain.yaml ps --format 'table {{.Service}}\t{{.Status}}'"
done
echo "deploy: $REV is running; https://api.161.35.99.236.sslip.io/health"
