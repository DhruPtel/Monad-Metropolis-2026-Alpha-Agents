#!/usr/bin/env bash
# CO-U1 (2026-10-19): RPC calls per container over a window, from the RPC router's counts.
#
#   infra/server/rpc-usage.sh [seconds]
#
# Resets the router's counts, then every 2 seconds maps each connection to the router (in each
# stack's network namespace) to the container whose process holds it, and at the end prints calls
# per minute per container and route with the heaviest methods. Prints no URL and no key.
set -euo pipefail
SECONDS_WINDOW=${1:-600}
ROUTER=vivarium-rpc-rpc-router-1
MAP=$(mktemp)
trap 'rm -f "$MAP"' EXIT

docker exec "$ROUTER" node -e "fetch('http://127.0.0.1:8899/stats/reset',{method:'POST'}).then(r=>r.text()).then(console.log)" >/dev/null
declare -A NAME_OF
end=$((SECONDS + SECONDS_WINDOW))
while [ $SECONDS -lt $end ]; do
  # Container id to name, for every running container.
  while read -r id name; do NAME_OF[$id]=$name; done < <(docker ps --no-trunc --format '{{.ID}} {{.Names}}')
  # One process per network namespace is enough to enter it.
  declare -A SEEN=()
  for id in "${!NAME_OF[@]}"; do
    pid=$(docker inspect -f '{{.State.Pid}}' "$id" 2>/dev/null || true)
    [ -n "$pid" ] && [ "$pid" != "0" ] || continue
    ns=$(readlink "/proc/$pid/ns/net" 2>/dev/null || true)
    [ -n "$ns" ] && [ -z "${SEEN[$ns]:-}" ] || continue
    SEEN[$ns]=1
    nsenter -t "$pid" -n ss -tnpH '( dport = :8899 )' 2>/dev/null | while read -r _ _ _ local _ users; do
      for p in $(grep -o 'pid=[0-9]*' <<<"$users" | cut -d= -f2); do
        cid=$(grep -o -m1 '[0-9a-f]\{64\}' "/proc/$p/cgroup" 2>/dev/null || true)
        [ -n "$cid" ] && echo "$local ${NAME_OF[$cid]:-$cid}"
      done
    done
  done >>"$MAP"
  unset SEEN
  sleep 2
done
sort -u "$MAP" | docker exec -i "$ROUTER" node -e '
const lines = require("fs").readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
const who = new Map(lines.map((l) => l.split(" ")));
fetch("http://127.0.0.1:8899/stats").then((r) => r.json()).then((s) => {
  const minutes = (Date.parse(s.now) - Date.parse(s.since)) / 60000;
  const rows = new Map();
  for (const [route, r] of Object.entries(s.routes)) {
    for (const [client, methods] of Object.entries(r.byClient)) {
      const key = `${who.get(client) ?? "unattributed"} ${route}`;
      const row = rows.get(key) ?? {};
      for (const [m, n] of Object.entries(methods)) row[m] = (row[m] ?? 0) + n;
      rows.set(key, row);
    }
    console.log(`route ${route}: ${(r.calls / minutes).toFixed(1)} calls/min, ${(r.upstreamCalls / minutes).toFixed(1)} upstream/min, ${r.cacheHits} cached, ${r.failovers} failovers, upstreams ${JSON.stringify(r.upstreams)}`);
  }
  console.log(`window ${minutes.toFixed(1)} min`);
  const sorted = [...rows].map(([k, m]) => [k, Object.values(m).reduce((a, b) => a + b, 0), m]).sort((a, b) => b[1] - a[1]);
  let total = 0;
  for (const [k, n, m] of sorted) {
    total += n;
    const top = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([x, c]) => `${x} ${(c / minutes).toFixed(1)}`).join(", ");
    console.log(`${k.padEnd(62)} ${(n / minutes).toFixed(1).padStart(7)}/min  ${top}`);
  }
  console.log(`total ${(total / minutes).toFixed(1)} calls/min`);
  // The heaviest eth_call targets (contract and function selector) per container.
  const calls = new Map();
  for (const r of Object.values(s.routes))
    for (const [client, whats] of Object.entries(r.byCallClient ?? {})) {
      const name = who.get(client) ?? "unattributed";
      const m = calls.get(name) ?? {};
      for (const [w, n] of Object.entries(whats)) m[w] = (m[w] ?? 0) + n;
      calls.set(name, m);
    }
  for (const [name, m] of calls) {
    const top = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`eth_call ${name}: ${top.map(([w, n]) => `${w} ${(n / minutes).toFixed(1)}`).join("; ")}`);
  }
});'
