/**
 * 2026-10-14: the hosted site's same-origin API path. The browser calls the site's own
 * `/api/...` (dev-api-proxy.ts) and src/app/api/[...path]/route.ts forwards each request to
 * CONTROL_API_URL, so networks that filter the API's host still reach it. Every forwarded
 * request carries the caller's own IP and PROXY_SHARED_SECRET, so the API's guard limits each
 * real user by their own address instead of all of them by Vercel's (scripts/host-tunnel.js).
 * The secret is a server-only runtime variable: it is read per request, never inlined.
 */
export const CLIENT_IP_HEADER = "x-vivarium-client-ip";
export const PROXY_SECRET_HEADER = "x-vivarium-proxy-secret";

const IP = /^[0-9a-fA-F:.]{3,45}$/;
/** Never copied from the caller: hop-by-hop, ours, or Vercel's and the edge's own. */
const DROP_REQUEST = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "te",
  "trailer",
  "host",
  "content-length",
  "accept-encoding",
  "forwarded",
  "x-real-ip",
  CLIENT_IP_HEADER,
  PROXY_SECRET_HEADER,
]);
/** fetch decodes the body itself, so the length and encoding no longer describe it. */
const DROP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

/** The caller's IP as Vercel's edge saw it, or null. */
export function callerIp(headers: Headers): string | null {
  const raw = headers.get("x-vercel-forwarded-for") ?? headers.get("x-forwarded-for");
  const first = raw?.split(",")[0]?.trim();
  return first && IP.test(first) ? first : null;
}

/** The headers sent to the API: the caller's, minus the dropped ones, plus ours. */
export function forwardHeaders(incoming: Headers, secret: string | undefined): Headers {
  const out = new Headers();
  incoming.forEach((value, name) => {
    const n = name.toLowerCase();
    if (DROP_REQUEST.has(n) || n.startsWith("x-forwarded-") || n.startsWith("x-vercel-")) return;
    out.set(n, value);
  });
  const ip = callerIp(incoming);
  if (secret && ip) {
    out.set(CLIENT_IP_HEADER, ip);
    out.set(PROXY_SECRET_HEADER, secret);
  }
  return out;
}

export function responseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value, name) => {
    const n = name.toLowerCase();
    if (!DROP_RESPONSE.has(n) && !n.startsWith("access-control-")) out.append(n, value);
  });
  return out;
}

/** Forwards one request to the control API; null when the proxy is off here. */
export async function forwardToApi(
  req: Request,
  env: Readonly<Record<string, string | undefined>>,
  send: typeof fetch = fetch,
): Promise<Response | null> {
  const target = env.CONTROL_API_URL?.trim().replace(/\/+$/, "");
  if (env.WEB_API_PROXY?.trim() !== "1" || !target) return null;
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  const method = req.method.toUpperCase();
  try {
    const upstream = await send(`${target}${path}${url.search}`, {
      method,
      headers: forwardHeaders(req.headers, env.PROXY_SHARED_SECRET?.trim()),
      body: method === "GET" || method === "HEAD" ? null : await req.arrayBuffer(),
      redirect: "manual",
      cache: "no-store",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders(upstream.headers),
    });
  } catch {
    return Response.json(
      { error: "api_down", message: "The control API is not answering." },
      { status: 502 },
    );
  }
}
