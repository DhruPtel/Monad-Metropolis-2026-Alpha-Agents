// @ts-check
// pnpm host:up | host:down | host:status (HOST-U1): the public link to the
// testnet app's backend, beside the running testnet stack and without
// touching it. A guard in this process listens on 127.0.0.1:4190 and forwards
// to the control API on 4100 only /health and /v1/* (the public and owner
// routes), with rate limits per client and CORS for the web app's origins
// alone; a Cloudflare quick tunnel (no account, a random trycloudflare.com
// hostname per start) exposes the guard and nothing else: never the
// orchestrator (4200), LiteLLM (4000), Postgres, Redis, the signer or a fork.
// The testnet depositor registrar runs beside it (scripts/testnet-depositors.js).
//
//   pnpm host:up      starts the guard, the tunnel and the registrar; prints the public URL
//   pnpm host:down    stops them
//   pnpm host:status  the public URL and whether each part runs
//
// HOST_WEB_ORIGINS (comma-separated) names the web app's origins besides
// localhost:3000, such as the Vercel deployment's. Prints no key or RPC URL.
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { DEV_DIR, ROOT } from "./lib/paths.js";
import { alive } from "./lib/dev-all.js";

const API = { host: "127.0.0.1", port: 4100 };
const GUARD_PORT = Number(process.env.HOST_GUARD_PORT ?? 4190);
const STATE_PATH = join(DEV_DIR, "host.json");
const LOG_PATH = join(DEV_DIR, "host.log");
const TUNNEL_LOG_PATH = join(DEV_DIR, "host-tunnel.log");
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const ORIGINS_PATH = join(DEV_DIR, "host-origins.json");
/** The web app's origins besides localhost: HOST_WEB_ORIGINS, plus what pnpm host:vercel records; re-read live. */
let originsRead = 0;
/** @type {string[]} */
let extraOrigins = [];
function readOrigins() {
  if (Date.now() - originsRead < 5_000) return extraOrigins;
  originsRead = Date.now();
  /** @type {string[]} */
  let recorded = [];
  try {
    const parsed = /** @type {{ origins?: unknown }} */ (
      JSON.parse(readFileSync(ORIGINS_PATH, "utf8"))
    );
    if (Array.isArray(parsed.origins))
      recorded = parsed.origins.filter((o) => typeof o === "string");
  } catch {
    recorded = [];
  }
  extraOrigins = [...(process.env.HOST_WEB_ORIGINS ?? "").split(","), ...recorded]
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter((o) => /^https?:\/\/[^/]+$/.test(o));
  return extraOrigins;
}

/** The routes the guard forwards: the control API's public and owner routes, nothing else. */
const ALLOWED_PATH =
  /^\/(health|v1\/(session|supply|agents(\/.*)?|goal\/preview|mint\/(eligibility|claim)))$/;

/**
 * Rate limits per client address, as requests a minute: the mint and session
 * routes tightest, every owner action next, reads last. A client over its
 * limit gets 429 with when to try again; nothing is forwarded.
 */
const LIMITS = {
  mint: { match: /^\/v1\/(mint\/|agents\/\d+\/session$)/, perMinute: 10 },
  action: { match: /./, methods: new Set(["POST", "PUT", "DELETE"]), perMinute: 30 },
  read: { match: /./, perMinute: 240 },
};
/** @type {Map<string, number[]>} */
const hits = new Map();
/** @param {string} key @param {number} perMinute */
function overLimit(key, perMinute) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= perMinute) {
    hits.set(key, list);
    return true;
  }
  list.push(now);
  hits.set(key, list);
  return false;
}
/**
 * 2026-10-14: the hosted site forwards its visitors' requests from Vercel's addresses, adding
 * each visitor's own IP and PROXY_SHARED_SECRET (apps/web/src/api/proxy.ts). The forwarded IP
 * counts only with the right secret; anything else, a direct call included, is limited by the
 * address it comes from. The secret is never logged or passed on.
 */
const CLIENT_IP_HEADER = "x-vivarium-client-ip";
const PROXY_SECRET_HEADER = "x-vivarium-proxy-secret";
const PROXY_SECRET = Buffer.from(process.env.PROXY_SHARED_SECRET?.trim() ?? "");
/** @param {import("node:http").IncomingMessage} req @returns {string | null} */
function proxiedClient(req) {
  const got = req.headers[PROXY_SECRET_HEADER];
  if (PROXY_SECRET.length === 0 || typeof got !== "string") return null;
  const given = Buffer.from(got);
  if (given.length !== PROXY_SECRET.length || !timingSafeEqual(given, PROXY_SECRET)) return null;
  const ip = req.headers[CLIENT_IP_HEADER];
  return typeof ip === "string" && /^[0-9a-fA-F:.]{3,45}$/.test(ip.trim()) ? ip.trim() : null;
}
/** @param {import("node:http").IncomingMessage} req */
function clientOf(req) {
  const proxied = proxiedClient(req);
  if (proxied) return `${proxied} (via the site)`;
  const cf = req.headers["cf-connecting-ip"];
  const fwd = req.headers["x-forwarded-for"];
  const raw =
    (typeof cf === "string" && cf) ||
    (typeof fwd === "string" && fwd.split(",")[0]) ||
    req.socket.remoteAddress ||
    "unknown";
  return raw.trim();
}
/** @param {string | undefined} origin */
function originAllowed(origin) {
  if (!origin) return false;
  return LOOPBACK.test(origin) || readOrigins().includes(origin.replace(/\/$/, ""));
}

function startGuard() {
  const log = createWriteStream(LOG_PATH, { flags: "a" });
  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const cors = originAllowed(origin)
      ? {
          "access-control-allow-origin": /** @type {string} */ (origin),
          "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
          "access-control-allow-headers": "authorization,content-type,x-owner-session",
          "access-control-max-age": "600",
          vary: "origin",
        }
      : { vary: "origin" };
    if (method === "OPTIONS") {
      res.writeHead(originAllowed(origin) ? 204 : 403, cors);
      res.end();
      return;
    }
    if (!ALLOWED_PATH.test(path)) {
      res.writeHead(404, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", message: "No such route." }));
      return;
    }
    const client = clientOf(req);
    const cls = LIMITS.mint.match.test(path)
      ? ["mint", LIMITS.mint.perMinute]
      : LIMITS.action.methods.has(method)
        ? ["action", LIMITS.action.perMinute]
        : ["read", LIMITS.read.perMinute];
    if (overLimit(`${client}:${cls[0]}`, /** @type {number} */ (cls[1]))) {
      log.write(`${new Date().toISOString()} 429 ${cls[0]} ${method} ${path} from ${client}\n`);
      res.writeHead(429, { ...cors, "content-type": "application/json", "retry-after": "60" });
      res.end(
        JSON.stringify({
          error: "rate_limited",
          message: "Too many requests from this address; try again in a minute.",
        }),
      );
      return;
    }
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.origin;
    delete headers["x-vivarium-client-ip"];
    delete headers["x-vivarium-proxy-secret"];
    const upstream = httpRequest(
      { host: API.host, port: API.port, method, path: req.url ?? "/", headers },
      (up) => {
        const out = {
          ...Object.fromEntries(
            Object.entries(up.headers).filter(([h]) => !h.startsWith("access-control-")),
          ),
          ...cors,
        };
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ error: "api_down", message: "The control API is not answering." }));
    });
    req.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(GUARD_PORT, "127.0.0.1", () => resolve(server));
  });
}

/** @returns {{ supervisor: number, tunnel: number, registrar: number | null, url: string | null } | null} */
function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}
async function up() {
  mkdirSync(DEV_DIR, { recursive: true });
  const previous = readState();
  if (previous && alive(previous.supervisor))
    fail(
      `the host tunnel is already running (PID ${previous.supervisor}); pnpm host:down stops it`,
    );
  const health = await fetch(`http://${API.host}:${API.port}/health`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!health)
    fail("the testnet control API on 4100 is not answering; start the stack with pnpm testnet:up");
  await startGuard();
  const tunnelLog = createWriteStream(TUNNEL_LOG_PATH, { flags: "w" });
  const tunnel = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://127.0.0.1:${GUARD_PORT}`, "--no-autoupdate"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  /** @type {string | null} */
  let url = null;
  const onData = (/** @type {Buffer} */ chunk) => {
    const text = chunk.toString("utf8");
    tunnelLog.write(text);
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
    if (m && !url) {
      url = m[0];
      announce();
    }
  };
  tunnel.stdout?.on("data", onData);
  tunnel.stderr?.on("data", onData);
  const registrar = spawn(process.execPath, ["scripts/testnet-depositors.js", "watch"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: process.env,
  });
  const registrarLog = createWriteStream(join(DEV_DIR, "host-registrar.log"), { flags: "a" });
  registrar.stdout?.pipe(registrarLog);
  registrar.stderr?.pipe(registrarLog);
  const state = {
    supervisor: process.pid,
    tunnel: tunnel.pid ?? 0,
    registrar: registrar.pid ?? null,
    url,
  };
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  const announce = () => {
    writeFileSync(STATE_PATH, `${JSON.stringify({ ...state, url }, null, 2)}\n`);
    console.log(`host: public API URL ${url}`);
    console.log(
      `host: the web app's CONTROL_API_URL on Vercel must be this URL (it changes at every start of a quick tunnel): pnpm host:vercel deploys with it.`,
    );
    console.log(
      `host: CORS allows localhost:3000${readOrigins().length ? ` and ${readOrigins().join(", ")}` : ""}; pnpm host:vercel records the deployment's origin in .dev/host-origins.json, read live.`,
    );
  };
  console.log(
    `host: guard on 127.0.0.1:${GUARD_PORT} forwarding /health and /v1/* to the control API on ${API.port}; rate limits ${LIMITS.mint.perMinute}/${LIMITS.action.perMinute}/${LIMITS.read.perMinute} a minute (mint and sessions, owner actions, reads)`,
  );
  console.log(
    "host: tunnel starting; the public URL prints when Cloudflare assigns it. Ctrl-C or pnpm host:down stops everything.",
  );
  const shutdown = () => {
    for (const pid of [tunnel.pid, registrar.pid])
      if (pid)
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            /* gone */
          }
        }
    rmSync(STATE_PATH, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  tunnel.on("exit", (code) => {
    console.log(`host: the tunnel exited (${code}); stopping`);
    shutdown();
  });
  await new Promise(() => undefined);
}

function down() {
  const state = readState();
  if (!state) {
    console.log("host: not running");
    return;
  }
  for (const pid of [state.tunnel, state.registrar, state.supervisor]) {
    if (!pid) continue;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
  }
  rmSync(STATE_PATH, { force: true });
  console.log("host: stopped the tunnel, the guard and the registrar");
}

function status() {
  const state = readState();
  if (!state || !alive(state.supervisor)) {
    console.log("host: not running");
    return;
  }
  console.log(
    `host: running; public API URL ${state.url ?? "(not assigned yet)"}; tunnel ${alive(state.tunnel) ? "up" : "down"}; registrar ${state.registrar && alive(state.registrar) ? "up" : "down"}`,
  );
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const command = process.argv[2];
if (command === "up") await up();
else if (command === "down") down();
else if (command === "status") status();
else {
  console.error("usage: node scripts/host-tunnel.js up | down | status");
  process.exit(2);
}
