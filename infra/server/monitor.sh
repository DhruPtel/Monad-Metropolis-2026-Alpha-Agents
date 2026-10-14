#!/usr/bin/env bash
# The cloud server's monitor (docs/HOSTING.md), run every 5 minutes by vivarium-monitor.timer.
# Alerts go to an ntfy topic (NTFY_TOPIC in /opt/vivarium/monitor.env) as phone or browser push:
# when a problem starts, every 6 hours while it lasts, and when it clears; plus one "all good"
# summary a day, so a silent monitor is itself a sign. Prints and sends no key or RPC URL.
set -uo pipefail

SRC=/opt/vivarium/src
STATE=/var/lib/vivarium-monitor
PUBLIC_HEALTH=https://api.161.35.99.236.sslip.io/health
REPEAT_SECONDS=$((6 * 3600))
BALANCE_EVERY_SECONDS=$((15 * 60))
# shellcheck disable=SC1091
source /opt/vivarium/monitor.env
NTFY_SERVER=${NTFY_SERVER:-https://ntfy.sh}
mkdir -p "$STATE"
cd "$SRC" || exit 1
dc() { docker compose --env-file /opt/vivarium/.env -f infra/server/compose.yaml "$@"; }

notify() { # title, priority, body
  curl -fsS -m 20 -H "Title: $1" -H "Priority: $2" -H "Tags: vivarium" \
    -d "$3" "$NTFY_SERVER/$NTFY_TOPIC" -o /dev/null || echo "monitor: could not reach ntfy"
}

problems=()
for svc in $(dc config --services); do
  id=$(dc ps -q "$svc" 2>/dev/null)
  if [ -z "$id" ]; then
    problems+=("service $svc is not running")
    continue
  fi
  st=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")
  case "$st" in
    "running healthy" | "running starting" | "running ") ;;
    *) problems+=("service $svc is $st") ;;
  esac
done
curl -fsS -m 20 -o /dev/null "$PUBLIC_HEALTH" || problems+=("the public API $PUBLIC_HEALTH is not answering")
avail=$(df --output=avail -BG / | tail -1 | tr -dc 0-9)
[ "${avail:-0}" -lt 10 ] && problems+=("only ${avail} GB of disk is free")

# Balances: every 15 minutes, from the API container (it has the keys to derive addresses).
now=$(date +%s)
last=$(cat "$STATE/balances-at" 2>/dev/null || echo 0)
if [ $((now - last)) -ge $BALANCE_EVERY_SECONDS ]; then
  if out=$(dc exec -T api node scripts/server-balances.js 2>&1); then
    printf '%s\n' "$out" > "$STATE/balances.txt"
  else
    printf 'ERR  the balance check failed: %s\n' "$(printf '%s' "$out" | tail -1)" > "$STATE/balances.txt"
  fi
  echo "$now" > "$STATE/balances-at"
fi
while IFS= read -r line; do
  case "$line" in
    LOW*) problems+=("low balance: ${line#LOW  }") ;;
    ERR*) problems+=("${line#ERR  }") ;;
  esac
done < <(cat "$STATE/balances.txt" 2>/dev/null)

# Compare with the last run: alert on new problems, repeat old ones every 6 hours, note recoveries.
touch "$STATE/open"
: > "$STATE/open.new"
for p in "${problems[@]}"; do
  key=$(printf '%s' "$p" | sed -E 's/[0-9]+\.[0-9]+ MON/x MON/; s/[0-9]+ GB/x GB/' | sha1sum | cut -c1-12)
  since=$(awk -v k="$key" '$1 == k { print $2 }' "$STATE/open")
  sent=$(awk -v k="$key" '$1 == k { print $3 }' "$STATE/open")
  if [ -z "$since" ]; then
    notify "Vivarium: problem" high "$p"
    since=$now sent=$now
  elif [ $((now - sent)) -ge $REPEAT_SECONDS ]; then
    notify "Vivarium: still a problem" default "$p (since $(date -u -d "@$since" '+%Y-%m-%d %H:%M UTC'))"
    sent=$now
  fi
  printf '%s %s %s %s\n' "$key" "$since" "$sent" "$p" >> "$STATE/open.new"
done
while read -r key _since _sent text; do
  grep -q "^$key " "$STATE/open.new" || notify "Vivarium: recovered" low "$text"
done < "$STATE/open"
mv "$STATE/open.new" "$STATE/open"

# One daily summary after 15:00 UTC (8 AM Pacific).
today=$(date -u +%F)
if [ "$(date -u +%H)" -ge 15 ] && [ "$(cat "$STATE/daily" 2>/dev/null)" != "$today" ]; then
  if [ ${#problems[@]} -eq 0 ]; then
    notify "Vivarium: daily check, all good" low "Every service is healthy, the public API answers, every operator wallet is above its floor. $(cat "$SRC/REVISION" 2>/dev/null)"
  else
    notify "Vivarium: daily check, ${#problems[@]} open" default "$(printf '%s\n' "${problems[@]}")"
  fi
  echo "$today" > "$STATE/daily"
fi
printf 'monitor: %s problem(s)\n' "${#problems[@]}"
for p in "${problems[@]}"; do printf '  %s\n' "$p"; done
