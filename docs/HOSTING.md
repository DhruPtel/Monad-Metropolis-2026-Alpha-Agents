# Hosting the testnet backend

Since 2026-10-14 the whole testnet backend runs on one cloud server, not on the laptop. The web app stays on Vercel (https://vivarium-testnet.vercel.app) and calls the API at **https://api.161.35.99.236.sslip.io**.

| What             | Where                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| Server           | DigitalOcean droplet `root@161.35.99.236`, Ubuntu 24.04, 2 vCPU, 4 GB RAM, 4 GB swap, weekly droplet backups |
| Code             | `/opt/vivarium/src` (a `git archive` of the deployed commit; `REVISION` names it)                            |
| Secrets          | `/opt/vivarium/.env`, root only, mode 600 (never print it)                                                   |
| Monitor settings | `/opt/vivarium/monitor.env` (the ntfy topic)                                                                 |
| Database backups | `/opt/vivarium/backups` (nightly, kept 14 days)                                                              |
| Stack definition | `infra/server/compose.yaml`, `infra/server/Dockerfile`, `infra/server/caddy/Caddyfile`                       |

## What runs

Docker Compose project `vivarium`. Every service has `restart: always` and a health check.

| Service         | What it is                                                                                                                                                                                                  | Health check                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `postgres`      | Postgres 16: `alpha_agents_testnet` (the app) and `alpha_agents` (LiteLLM's schema: gateway keys and spend)                                                                                                 | `pg_isready`                               |
| `redis`         | Redis 7 (the app uses database 1)                                                                                                                                                                           | `redis-cli ping`                           |
| `litellm`       | the model gateway, `infra/litellm/config.yaml` (15 USD a day cap)                                                                                                                                           | `/health/liveliness`                       |
| `api`           | the control API, port 4100 inside                                                                                                                                                                           | `/health`                                  |
| `orchestrator`  | research, the reveal keeper, the signer, the trade flow, credits, the token registrar and screens (with anvil), the on-demand feed re-dates, the sentinel and the attestor; port 4200 inside, loopback only | `/health`                                  |
| `indexer`       | AgentNFT and USDC events into the database                                                                                                                                                                  | its watermark moved in the last 15 minutes |
| `registrar`     | the depositor registrar (`scripts/testnet-depositors.js watch`)                                                                                                                                             | the database answers                       |
| `research-base` | Base tokens for research, hourly                                                                                                                                                                            | the database answers                       |
| `guard`         | `scripts/host-tunnel.js guard`: only `/health` and `/v1/*`, CORS for the Vercel site, per-client rate limits                                                                                                | `/health` through it                       |
| `caddy`         | HTTPS for `api.161.35.99.236.sslip.io` (Let's Encrypt, renewed automatically), proxies to the guard                                                                                                         | admin endpoint                             |
| `app-net`       | holds the network namespace the app services share, so they reach each other on 127.0.0.1 as on the laptop                                                                                                  | trivial                                    |

Only Caddy publishes ports (80 and 443). The firewall (ufw) allows SSH, 80 and 443. SSH takes keys only. Security updates install automatically (unattended-upgrades).

The orchestrator still opens its own Cloudflare quick tunnel for the E2B sandboxes to reach its gate. That tunnel is outbound only and its URL is used per run, so a changing URL is harmless.

## SSH in

```sh
ssh -i ~/.ssh/vivarium root@161.35.99.236
cd /opt/vivarium/src
alias dc='docker compose --env-file /opt/vivarium/.env -f infra/server/compose.yaml'
```

The commands below assume that `cd` and `alias`.

## Status, restart, logs

```sh
dc ps                               # every service with its health
dc restart orchestrator             # restart one service
dc restart                          # restart everything
dc up -d                            # start whatever is not running
dc logs -f --tail 100 orchestrator  # follow one service's log
dc logs --since 1h api guard        # the last hour of two services
cat REVISION                        # the deployed commit
```

Logs rotate at 20 MB, five files per container. A reboot brings everything back on its own (Docker starts at boot and every service has `restart: always`).

## Update to a new commit

From the laptop, in the repo, after committing:

```sh
scripts/server-deploy.sh            # deploys HEAD
scripts/server-deploy.sh 8acc441    # deploys that commit
```

It sends the commit's files only (never `.env`, `.dev` or untracked files), builds `vivarium-backend:<commit>` on the server, recreates whatever changed, waits for every health check, and prints the status. A deploy takes about 3 to 5 minutes.

Roll back to an earlier image without sending code:

```sh
docker tag vivarium-backend:<old commit> vivarium-backend:latest && dc up -d --wait
```

The web app is separate: after a change to `apps/web`, run `HOST_API_URL=https://api.161.35.99.236.sslip.io pnpm host:vercel` on the laptop. The API address no longer changes, so the backend's restarts never need a Vercel redeploy.

## Change a secret

```sh
nano /opt/vivarium/.env             # on the server; never cat it
dc up -d --force-recreate           # the services read it at start
```

Only the keys the backend needs are there. The canary keys, the guardian key, the test wallet's key and the local fork's keys stay on the laptop.

## Wallet balances

```sh
dc exec -T api node scripts/server-balances.js
```

It prints every operator wallet, its MON balance and its alert floor, marking a wallet under its floor `LOW`: the deployer (it refills the others and adds depositors, floor 2 MON), the token registrar's screener, the attestor and the sentinel (0.1 each), the reveal keeper (0.15), the feed writer (0.05) and every armed agent's session key, which the signer spends from (0.3). Fund a wallet by sending testnet MON to its address from any wallet; the deployer can top the keeper and the feed writer up to their targets with `dc exec -T api node scripts/testnet-gas.js`.

## Alerts

`vivarium-monitor.timer` runs `infra/server/monitor.sh` every 5 minutes. It checks every service's state and health, the public API over HTTPS, free disk, and (every 15 minutes) the wallet balances above. Alerts go to the ntfy topic named in `/opt/vivarium/monitor.env`:

- a push when a problem starts, again every 6 hours while it lasts, and one when it clears;
- one daily summary after 15:00 UTC (8 AM Pacific), "all good" or the open problems. No daily summary means the server or the monitor is down.

To receive them, install the ntfy app (iOS or Android) or open https://ntfy.sh in a browser, and subscribe to the topic name in `monitor.env`. Anyone who knows the topic name can read it, so keep it to yourself; messages carry only service names, wallet addresses and balances.

```sh
systemctl start vivarium-monitor.service; journalctl -u vivarium-monitor -n 20   # run it now
systemctl list-timers 'vivarium-*'                                              # when it runs next
```

The monitor runs on the server, so it cannot report the server itself being off; the missing daily summary is the sign of that.

## Backups and restore

`vivarium-backup.timer` dumps `alpha_agents_testnet` and LiteLLM's schema every night at 10:00 UTC into `/opt/vivarium/backups` (14 days kept). DigitalOcean's weekly backups hold the whole disk besides. Run one now with `systemctl start vivarium-backup.service`.

Restore the app database from a dump (this replaces what is there):

```sh
dc stop api orchestrator indexer registrar research-base guard
dc exec -T postgres psql -U alpha -d alpha_agents -c "drop database alpha_agents_testnet"
dc exec -T postgres psql -U alpha -d alpha_agents -c "create database alpha_agents_testnet"
dc exec -T postgres pg_restore -U alpha -d alpha_agents_testnet --no-owner /backups/testnet-<stamp>.dump
dc up -d --wait
```

LiteLLM's schema restores the same way into `alpha_agents` (`drop schema litellm cascade` first, then `pg_restore -d alpha_agents --no-owner /backups/litellm-<stamp>.dump`, then `dc restart litellm`). To restore the whole server, restore a droplet backup from the DigitalOcean dashboard (Droplet, Backups).

## The laptop

The laptop no longer runs the testnet backend. Do not run `pnpm testnet:up` or `pnpm host:up` while the server runs: two keepers and two signers on the same keys would race each other's transactions. The laptop's Docker Postgres keeps the database as it was at the move (2026-10-14, 16:34 UTC) as a backup.
