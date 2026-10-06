import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type AgentIdentity, type IdentityResolver, sha256Hex } from "./conventions.ts";

/** A resolver over fixed tokens, for tests and the P1-U1 spike. */
export function staticResolver(tokens: Readonly<Record<string, AgentIdentity>>): IdentityResolver {
  const byHash = new Map(Object.entries(tokens).map(([t, id]) => [sha256Hex(t), id]));
  return async (hash) => byHash.get(hash) ?? null;
}

/** An MCP client that sends the token the way the gate forwards it. */
export async function connectClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    // The SDK's types disagree under exactOptionalPropertyTypes; the transport is unchanged.
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as Transport,
  );
  return client;
}

/** The structured content of a tool result, or of its error. */
export function structured(result: unknown): Record<string, unknown> {
  return ((result as { structuredContent?: Record<string, unknown> }).structuredContent ??
    {}) as Record<string, unknown>;
}
