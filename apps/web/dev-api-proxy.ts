/**
 * UI-FAST: a dev-only proxy to the control API. A dev server on another port
 * (3100 beside the testnet stack's 3000) is an origin the API's CORS refuses
 * outside the local environment, so with WEB_DEV_API_PROXY=1 the browser calls
 * the dev server's own `/dev-api/...` and Next forwards each request to
 * CONTROL_API_URL. Only `next dev` reads it: a build or `next start` never
 * carries the rewrite or the browser path.
 */
export const DEV_API_PROXY_PATH = "/dev-api";
export const DEV_API_PROXY_FLAG = "WEB_DEV_API_PROXY";

export interface DevApiProxy {
  /** The path the browser calls; "" when the proxy is off. */
  readonly browserPath: string;
  readonly rewrites: readonly { readonly source: string; readonly destination: string }[];
}

export function devApiProxy(
  phase: string,
  env: Readonly<Record<string, string | undefined>>,
): DevApiProxy {
  const on = phase === "phase-development-server" && env[DEV_API_PROXY_FLAG]?.trim() === "1";
  if (!on) return { browserPath: "", rewrites: [] };
  const target = (env.CONTROL_API_URL?.trim() || "http://127.0.0.1:4100").replace(/\/+$/, "");
  return {
    browserPath: DEV_API_PROXY_PATH,
    rewrites: [{ source: `${DEV_API_PROXY_PATH}/:path*`, destination: `${target}/:path*` }],
  };
}
