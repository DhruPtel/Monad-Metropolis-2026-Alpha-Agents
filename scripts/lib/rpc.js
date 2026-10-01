// @ts-check

/**
 * Error from an RPC call. The message never contains the endpoint URL.
 */
export class RpcError extends Error {
  /**
   * @param {string} message
   * @param {"unreachable" | "http" | "jsonrpc" | "malformed"} kind
   * @param {number | undefined} [code]
   */
  constructor(message, kind, code) {
    super(message);
    this.kind = kind;
    this.code = code;
  }
}

/**
 * Minimal JSON-RPC call. Errors are rethrown without the URL or the
 * underlying fetch error, which can include the host.
 * @param {string} url
 * @param {string} method
 * @param {unknown[]} [params]
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>}
 */
export async function rpc(url, method, params = [], timeoutMs = 10_000) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RpcError(`${method}: endpoint unreachable or timed out`, "unreachable");
  }
  if (!response.ok) {
    throw new RpcError(`${method}: HTTP ${response.status}`, "http", response.status);
  }
  /** @type {any} */
  let body;
  try {
    body = await response.json();
  } catch {
    throw new RpcError(`${method}: response is not JSON`, "malformed");
  }
  if (body?.error) {
    const code = typeof body.error.code === "number" ? body.error.code : undefined;
    throw new RpcError(`${method}: JSON-RPC error ${code ?? ""}`.trim(), "jsonrpc", code);
  }
  if (!("result" in (body ?? {}))) {
    throw new RpcError(`${method}: response has no result`, "malformed");
  }
  return body.result;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function hexToNumber(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new RpcError(`expected a hex quantity`, "malformed");
  }
  const n = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(n)) throw new RpcError("hex quantity out of range", "malformed");
  return n;
}
