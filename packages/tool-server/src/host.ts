import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type AgentIdentity,
  type IdentityResolver,
  type ToolErrorCode,
  errorResult,
  sha256Hex,
} from "./conventions.ts";

/**
 * Hosts one MCP tool server over Streamable HTTP on loopback (D-213). It is
 * stateless: every request gets its own McpServer, built for the identity
 * its bearer token resolves to, so an MCP session can never carry one agent's
 * identity into another agent's request, and `Mcp-Session-Id` is never
 * authentication. A request with no token, a short one, or one that names no
 * active lease is refused with 401 before any tool code runs.
 */
export interface ToolServerOptions {
  /** The MCP server name (data, platform). */
  readonly name: string;
  readonly resolve: IdentityResolver;
  /** Registers the server's tools for one request's identity. */
  readonly register: (mcp: McpServer, identity: AgentIdentity) => void;
  readonly port?: number;
}

export interface ToolServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Gate tokens are 32 random bytes; anything shorter is not one. */
const MIN_TOKEN_LENGTH = 32;

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length >= MIN_TOKEN_LENGTH ? token : null;
}

function refuse(res: ServerResponse, status: number, code: ToolErrorCode, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code, message } }));
}

/**
 * The SDK answers a call whose input fails the schema (or whose output fails
 * the output schema) with a plain-text error before or after the handler.
 * This puts those answers in the 4.4.1 shape too. The SDK keeps the method
 * private, so the override is checked by the tool servers' tests.
 */
function useTypedSdkErrors(mcp: McpServer): void {
  (mcp as unknown as { createToolError: (message: string) => CallToolResult }).createToolError = (
    message,
  ) => {
    if (/^(MCP error -?\d+: )?Input validation error/.test(message))
      return errorResult({ code: "INVALID_INPUT", message, retryable: false });
    if (/^(MCP error -?\d+: )?Output validation error/.test(message))
      return errorResult({ code: "INTERNAL", message, retryable: false });
    if (/Tool \S+ (not found|disabled)/.test(message))
      return errorResult({ code: "INVALID_INPUT", message, retryable: false });
    return errorResult({
      code: "INTERNAL",
      message: "The tool failed on the server.",
      retryable: true,
    });
  };
}

export async function startToolServer(options: ToolServerOptions): Promise<ToolServer> {
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/mcp") return refuse(res, 404, "INVALID_INPUT", "not found");
    const token = bearer(req);
    if (!token) return refuse(res, 401, "UNAUTHENTICATED", "unauthenticated");
    void (async () => {
      let identity: AgentIdentity | null;
      try {
        identity = await options.resolve(sha256Hex(token));
      } catch {
        return refuse(res, 503, "INTERNAL", "identity unavailable");
      }
      if (!identity) return refuse(res, 401, "UNAUTHENTICATED", "unauthenticated");
      const mcp = new McpServer({ name: options.name, version: "1.0.0" });
      useTypedSdkErrors(mcp);
      options.register(mcp, identity);
      // No session ID generator: stateless mode, one server and transport per request.
      const transport = new StreamableHTTPServerTransport({});
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      try {
        // The SDK's own types disagree under exactOptionalPropertyTypes (optional callbacks
        // declared without `| undefined`); the object is the SDK's transport, unchanged.
        await mcp.connect(transport as Transport);
        await transport.handleRequest(req, res);
      } catch {
        if (!res.headersSent) refuse(res, 500, "INTERNAL", "internal error");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
