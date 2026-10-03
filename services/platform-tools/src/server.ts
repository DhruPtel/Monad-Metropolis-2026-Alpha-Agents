import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CompleteStageInput, CompleteStageOutput } from "./schema.ts";

export interface StageRecord {
  readonly receivedAt: string;
  readonly input: CompleteStageInput;
  readonly output: CompleteStageOutput;
}

export interface PlatformToolsOptions {
  /** The per-agent tool token. Requests must carry it as a bearer token. */
  readonly token: string;
  /** Builds the tool's structured output. Tests replace it to prove invalid output is rejected. */
  readonly buildOutput?: (input: CompleteStageInput) => unknown;
}

export interface PlatformToolsServer {
  readonly url: string;
  readonly stages: readonly StageRecord[];
  close(): Promise<void>;
}

function defaultOutput(input: CompleteStageInput): CompleteStageOutput {
  return {
    stageId: `stage-${randomUUID()}`,
    stage: input.stage,
    outcome: input.outcome,
    accepted: true,
    candidateCount: input.candidates.length,
  };
}

function bearerMatches(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function buildMcp(options: PlatformToolsOptions, stages: StageRecord[]): McpServer {
  const mcp = new McpServer({ name: "platform", version: "0.0.0" });
  const build = options.buildOutput ?? defaultOutput;
  mcp.registerTool(
    "complete_stage",
    {
      description:
        "End the current research stage. Call exactly once, as the last action of the stage, with codes only.",
      // The strict objects, not their raw shapes: the SDK wraps a raw shape in a non-strict
      // object, which silently strips unknown fields instead of rejecting them.
      inputSchema: CompleteStageInput,
      outputSchema: CompleteStageOutput,
    },
    (input) => {
      const output = build(input) as CompleteStageOutput;
      stages.push({ receivedAt: new Date().toISOString(), input, output });
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: { ...output },
      };
    },
  );
  return mcp;
}

function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

/** Starts the stub platform tools server on 127.0.0.1. Stateless: one MCP server per request. */
export async function startPlatformTools(
  options: PlatformToolsOptions,
  port = 0,
): Promise<PlatformToolsServer> {
  if (options.token.length < 32) throw new Error("the tool token must be at least 32 characters");
  const stages: StageRecord[] = [];
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/mcp") return reject(res, 404, "not found");
    if (!bearerMatches(req, options.token)) return reject(res, 401, "unauthorized");
    const mcp = buildMcp(options, stages);
    // No session ID generator: stateless mode, one server and transport per request.
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    mcp
      // The SDK's own types disagree under exactOptionalPropertyTypes (optional callbacks
      // declared without `| undefined`); the object is the SDK's transport, unchanged.
      .connect(transport as Transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) reject(res, 500, "internal error");
      });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}/mcp`,
    stages,
    close: () =>
      new Promise<void>((resolve, reject_) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject_(err) : resolve()));
      }),
  };
}
