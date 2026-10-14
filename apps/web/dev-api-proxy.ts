/**
 * UI-FAST: a dev-only proxy to the control API. A dev server on another port
 * (3100 beside the testnet stack's 3000) is an origin the API's CORS refuses
 * outside the local environment, so with WEB_DEV_API_PROXY=1 the browser calls
 * the dev server's own `/dev-api/...` and Next forwards each request to
 * CONTROL_API_URL. Only `next dev` reads it: a build or `next start` never
 * carries this rewrite or this browser path (the hosted build has its own, below).
 */
export const DEV_API_PROXY_PATH = "/dev-api";
export const DEV_API_PROXY_FLAG = "WEB_DEV_API_PROXY";
/**
 * 2026-10-14: the hosted build's same-origin path. Networks that filter the API's own host
 * (*.sslip.io) left the browser unable to reach it, so with WEB_API_PROXY=1 (pnpm host:vercel)
 * a build has the browser call the site's own `/api/...`, which src/app/api/[...path]/route.ts
 * forwards to CONTROL_API_URL server-side. The server-side render keeps calling CONTROL_API_URL.
 */
export const API_PROXY_PATH = "/api";
export const API_PROXY_FLAG = "WEB_API_PROXY";

export interface DevApiProxy {
  /** The path the browser calls; "" when the proxy is off. */
  readonly browserPath: string;
  readonly rewrites: readonly { readonly source: string; readonly destination: string }[];
}

export function devApiProxy(
  phase: string,
  env: Readonly<Record<string, string | undefined>>,
): DevApiProxy {
  const target = (env.CONTROL_API_URL?.trim() || "http://127.0.0.1:4100").replace(/\/+$/, "");
  // The route src/app/api/[...path]/route.ts forwards it, adding the caller's IP and the proxy
  // secret (src/api/proxy.ts), which a rewrite cannot.
  if (env[API_PROXY_FLAG]?.trim() === "1") return { browserPath: API_PROXY_PATH, rewrites: [] };
  const on = phase === "phase-development-server" && env[DEV_API_PROXY_FLAG]?.trim() === "1";
  if (!on) return { browserPath: "", rewrites: [] };
  return {
    browserPath: DEV_API_PROXY_PATH,
    rewrites: [{ source: `${DEV_API_PROXY_PATH}/:path*`, destination: `${target}/:path*` }],
  };
}
