// CO-U1 (2026-10-19, owner): the server's RPC router. Every stack's services reach their chain
// through it (http://rpc-router:8899/<route>), so one place picks the provider, fails over,
// caches reads that cannot change within a block, and counts the calls.
//
//   node infra/server/rpc-router.mjs /etc/rpc-router.json
//
// The config maps each route to its upstreams in order, the chain's block time and whether reads
// are cached: { "port": 8899, "routes": { "monad-testnet": { "upstreams": ["https://..."],
// "blockMs": 400, "cache": true } } }. It holds provider URLs with their keys, so it lives on the
// server only (root, mode 600). Nothing here prints a URL: an upstream is named by its provider.
//
// GET /stats returns the counts since the start (or the last POST /stats/reset): per route, per
// method, per upstream, and per client connection (address:port), which the server's attribution
// script maps to a container.
/* global AbortSignal, Buffer, URL, console, fetch, process, setInterval */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** A provider's name from its hostname; never the URL. */
export function providerOf(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return "unparseable";
  }
  for (const [part, name] of [
    ["alchemy", "Alchemy"],
    ["quiknode", "QuickNode"],
    ["quicknode", "QuickNode"],
    ["monad.xyz", "Monad public"],
    ["drpc", "dRPC"],
    ["ankr", "Ankr"],
    ["chainstack", "Chainstack"],
    ["publicnode", "PublicNode"],
    ["base.org", "Base public"],
    ["arbitrum.io", "Arbitrum public"],
    ["blockvision", "BlockVision"],
  ])
    if (host.includes(part)) return name;
  return "other";
}

/** Reads that cannot change within a block: cached for the chain's block time. */
const PER_BLOCK = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getBlockByNumber",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getTransactionCount",
]);
/** Never change. */
const FOREVER = new Set(["eth_chainId", "net_version"]);

/**
 * How long a single request's answer may be reused, in ms: 0 for anything that can differ
 * within a block (a pending nonce, a send, an estimate, a receipt, logs).
 */
export function cacheMsFor(req, blockMs) {
  if (!req || typeof req.method !== "string") return 0;
  if (FOREVER.has(req.method)) return 3_600_000;
  if (!PER_BLOCK.has(req.method)) return 0;
  const params = Array.isArray(req.params) ? req.params : [];
  if (params.some((p) => p === "pending")) return 0;
  return blockMs;
}

/** An upstream answer that means "try the next provider": a limit, an outage, not a revert. */
export function shouldFailOver(status, body) {
  if (status === 429 || status >= 500) return true;
  if (status !== 200) return true;
  const one = Array.isArray(body) ? body[0] : body;
  const err = one && typeof one === "object" ? one.error : null;
  if (!err) return false;
  if (err.code === -32005 || err.code === -32007 || err.code === 429) return true;
  return /rate|limit exceeded|capacity|too many|daily|quota|exceeded/i.test(
    String(err.message ?? ""),
  );
}

export class Stats {
  constructor() {
    this.reset();
  }
  reset() {
    this.since = new Date().toISOString();
    this.routes = {};
    /** The counts at the last minute line, so each line shows that minute alone. */
    this.prev = {};
  }
  route(name) {
    this.routes[name] ??= {
      calls: 0,
      upstreamCalls: 0,
      cacheHits: 0,
      failovers: 0,
      failed: 0,
      byMethod: {},
      byClient: {},
      upstreams: {},
    };
    return this.routes[name];
  }
  call(route, client, method, req) {
    const r = this.route(route);
    r.calls += 1;
    r.byMethod[method] = (r.byMethod[method] ?? 0) + 1;
    r.byClient[client] ??= {};
    r.byClient[client][method] = (r.byClient[client][method] ?? 0) + 1;
    // Which contract and function each eth_call reads, so the heavy readers can be named.
    const tx = method === "eth_call" && Array.isArray(req?.params) ? req.params[0] : null;
    if (tx && typeof tx === "object") {
      const what = `${String(tx.to ?? "?").toLowerCase()} ${String(tx.data ?? tx.input ?? "").slice(0, 10)}`;
      r.byCallClient ??= {};
      r.byCallClient[client] ??= {};
      r.byCallClient[client][what] = (r.byCallClient[client][what] ?? 0) + 1;
    }
  }
  upstream(route, name, outcome) {
    const r = this.route(route);
    r.upstreams[name] ??= { calls: 0, ok: 0, failedOver: 0 };
    r.upstreams[name].calls += 1;
    if (outcome === "ok") r.upstreams[name].ok += 1;
    else r.upstreams[name].failedOver += 1;
  }
}

export class Router {
  /**
   * @param {{ routes: Record<string, { upstreams: string[], blockMs?: number, cache?: boolean, cacheGroup?: string }> }} config
   * @param {{ fetch?: typeof fetch, now?: () => number, timeoutMs?: number, cooldownMs?: number }} [o]
   */
  constructor(config, o = {}) {
    this.routes = config.routes;
    this.fetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.cooldownMs = o.cooldownMs ?? 30_000;
    this.stats = new Stats();
    this.cache = new Map();
    /** upstream index per route to the time it may be tried again after a limit. */
    this.cooling = new Map();
  }

  /** Answers one POST body for a route: [status, body text]. */
  async handle(route, client, text) {
    const cfg = this.routes[route];
    if (!cfg) return [404, JSON.stringify({ error: "no such route" })];
    let req;
    try {
      req = JSON.parse(text);
    } catch {
      return [
        400,
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        }),
      ];
    }
    const list = Array.isArray(req) ? req : [req];
    for (const r of list) this.stats.call(route, client, String(r?.method ?? "?"), r);
    const ttl =
      !Array.isArray(req) && cfg.cache !== false ? cacheMsFor(req, cfg.blockMs ?? 1_000) : 0;
    // Routes that name the same cacheGroup (one chain's primary and secondary) share answers.
    const key =
      ttl > 0
        ? `${cfg.cacheGroup ?? route} ${req.method} ${JSON.stringify(req.params ?? [])}`
        : null;
    if (key) {
      const hit = this.cache.get(key);
      if (hit && hit.until > this.now()) {
        this.stats.route(route).cacheHits += 1;
        return [200, JSON.stringify({ jsonrpc: "2.0", id: req.id ?? null, result: hit.result })];
      }
    }
    const [status, body] = await this.forward(route, cfg, text);
    if (
      key &&
      status === 200 &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      !body.error &&
      "result" in body
    ) {
      this.cache.set(key, { until: this.now() + ttl, result: body.result });
      if (this.cache.size > 20_000) this.prune();
    }
    return [status, typeof body === "string" ? body : JSON.stringify(body)];
  }

  prune() {
    const now = this.now();
    for (const [k, v] of this.cache) if (v.until <= now) this.cache.delete(k);
  }

  async forward(route, cfg, text) {
    const r = this.stats.route(route);
    let last = [
      502,
      { jsonrpc: "2.0", id: null, error: { code: -32603, message: "every upstream failed" } },
    ];
    const ups = cfg.upstreams;
    // Upstreams cooling after a limit go last, not never: when all are cooling, try them anyway.
    const order = ups
      .map((u, i) => ({ u, i, cool: (this.cooling.get(`${route}#${i}`) ?? 0) > this.now() }))
      .sort((a, b) => Number(a.cool) - Number(b.cool));
    for (const [n, { u, i }] of order.entries()) {
      const name = `${i}:${providerOf(u)}`;
      r.upstreamCalls += 1;
      let status;
      let body = null;
      try {
        const res = await this.fetch(u, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: text,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        status = res.status;
        const raw = await res.text();
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      } catch {
        status = 0;
      }
      if (!shouldFailOver(status, body)) {
        this.stats.upstream(route, name, "ok");
        return [status, body];
      }
      this.stats.upstream(route, name, "failover");
      if (status === 429 || (status === 200 && body))
        this.cooling.set(`${route}#${i}`, this.now() + this.cooldownMs);
      if (status !== 0 && body) last = [status === 200 ? 200 : status, body];
      if (n < order.length - 1) r.failovers += 1;
    }
    r.failed += 1;
    return last;
  }
}

/** Starts the HTTP server. */
export function serve(config, o = {}) {
  const router = new Router(config, o);
  const server = createServer((req, res) => {
    const client = `${req.socket.remoteAddress?.replace(/^::ffff:/, "")}:${req.socket.remotePort}`;
    const url = new URL(req.url ?? "/", "http://router");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (req.method === "GET" && url.pathname === "/stats") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          since: router.stats.since,
          now: new Date().toISOString(),
          routes: router.stats.routes,
        }),
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/stats/reset") {
      router.stats.reset();
      res.writeHead(200).end("reset");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      router
        .handle(
          url.pathname.replace(/^\/+|\/+$/g, ""),
          client,
          Buffer.concat(chunks).toString("utf8"),
        )
        .then(([status, body]) => {
          res
            .writeHead(status, { "content-type": "application/json", "keep-alive": "timeout=120" })
            .end(body);
        })
        .catch(() => res.writeHead(500).end());
    });
  });
  // Clients keep their connections, so the attribution script can tie each one to a container.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.listen(config.port ?? 8899, "0.0.0.0");
  // One line a minute per route: counts only, never a URL.
  setInterval(() => {
    const st = router.stats;
    for (const [name, r] of Object.entries(st.routes)) {
      const p = st.prev[name] ?? { calls: 0, upstreamCalls: 0, cacheHits: 0, failovers: 0 };
      console.log(
        `${new Date().toISOString()} ${name}: ${r.calls - p.calls} calls/min, ${r.upstreamCalls - p.upstreamCalls} upstream, ${r.cacheHits - p.cacheHits} cached, ${r.failovers - p.failovers} failovers`,
      );
      st.prev[name] = {
        calls: r.calls,
        upstreamCalls: r.upstreamCalls,
        cacheHits: r.cacheHits,
        failovers: r.failovers,
      };
    }
  }, 60_000).unref();
  console.log(
    `rpc router on :${config.port ?? 8899}: ${Object.entries(config.routes)
      .map(([n, c]) => `${n} -> ${c.upstreams.map(providerOf).join(", then ")}`)
      .join("; ")}`,
  );
  return { server, router };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serve(JSON.parse(readFileSync(process.argv[2] ?? "/etc/rpc-router.json", "utf8")));
}
