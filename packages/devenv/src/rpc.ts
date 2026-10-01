export type RpcErrorKind = "unreachable" | "http" | "jsonrpc" | "malformed";

/** Error from an RPC call. The message never contains the endpoint URL. */
export class RpcError extends Error {
  readonly kind: RpcErrorKind;
  readonly code: number | undefined;

  constructor(message: string, kind: RpcErrorKind, code?: number) {
    super(message);
    this.name = "RpcError";
    this.kind = kind;
    this.code = code;
  }
}

/**
 * Minimal JSON-RPC call. Errors are rethrown without the URL or the
 * underlying fetch error, which can include the host.
 */
export async function rpc(
  url: string,
  method: string,
  params: unknown[] = [],
  timeoutMs = 10_000,
): Promise<unknown> {
  let response: Response;
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
  let body: { error?: { code?: unknown }; result?: unknown } | null;
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new RpcError(`${method}: response is not JSON`, "malformed");
  }
  if (body?.error) {
    const code = typeof body.error.code === "number" ? body.error.code : undefined;
    throw new RpcError(`${method}: JSON-RPC error ${code ?? ""}`.trim(), "jsonrpc", code);
  }
  if (!body || !("result" in body)) {
    throw new RpcError(`${method}: response has no result`, "malformed");
  }
  return body.result;
}

/** A hex quantity as a safe integer (block numbers, chain IDs, timestamps). */
export function hexToNumber(value: unknown): number {
  const n = hexToBigInt(value);
  if (n > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RpcError("hex quantity out of range", "malformed");
  return Number(n);
}

/** A hex quantity as a bigint (balances, amounts). */
export function hexToBigInt(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new RpcError("expected a hex quantity", "malformed");
  }
  return BigInt(value);
}

export const toHex = (n: number | bigint): string => `0x${n.toString(16)}`;
