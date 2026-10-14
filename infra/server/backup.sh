#!/usr/bin/env bash
# The nightly database backup (docs/HOSTING.md), run by vivarium-backup.timer: the testnet
# database and LiteLLM's schema (the agents' gateway keys and spend), kept for 14 days in
# /opt/vivarium/backups. DigitalOcean's weekly droplet backups cover the whole disk besides.
set -euo pipefail
cd /opt/vivarium/src
dc() { docker compose --env-file /opt/vivarium/.env -f infra/server/compose.yaml "$@"; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dc exec -T postgres pg_dump -U alpha -d alpha_agents_testnet -Fc -f "/backups/testnet-$stamp.dump"
dc exec -T postgres pg_dump -U alpha -d alpha_agents -n litellm -Fc -f "/backups/litellm-$stamp.dump"
find /opt/vivarium/backups -name '*.dump' -mtime +14 -delete
ls -la /opt/vivarium/backups | tail -4
