import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type AgentIdentity, type IdentityResolver, sha256Hex } from "./conventions.ts";

/** A resolver over fixed tokens, for tests and the P1-U1 spike. */
export function staticResolver(tokens: Readonly<Record<string, AgentIdentity>>): IdentityResolver {
  const byHash = new Map(Object.entries(tokens).map(([t, id]) => [sha256Hex(t), id]));
  return async (hash) => byHash.get(hash) ?? null;
}

/**
 * An MCP client that sends the token the way the gate forwards it (a bearer),
 * or, with `header`, the way E2B injects it on the way to the gate. `extra`
 * adds headers a sandbox might send itself.
 */
export async function connectClient(
  url: string,
  token: string,
  options: { header?: string; extra?: Record<string, string> } = {},
): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  const auth = options.header ? { [options.header]: token } : { Authorization: `Bearer ${token}` };
  await client.connect(
    // The SDK's types disagree under exactOptionalPropertyTypes; the transport is unchanged.
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { ...options.extra, ...auth } },
    }) as Transport,
  );
  return client;
}

/** The structured content of a tool result, or of its error. */
export function structured(result: unknown): Record<string, unknown> {
  return ((result as { structuredContent?: Record<string, unknown> }).structuredContent ??
    {}) as Record<string, unknown>;
}
