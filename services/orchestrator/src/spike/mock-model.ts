import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted OpenAI-compatible model for the local smoke test only: it exercises Hermes'
 * plumbing (provider config, skill loading, MCP tools, /v1/runs) without a real model or any
 * key. It plays one stage: try to create a skill and to edit the mounted one (both must be
 * blocked), view the skill, call complete_stage with the skill's marker, then answer DONE. It never runs in a sandbox and never replaces LiteLLM in the real spike.
 */
export interface MockModel {
  readonly url: string;
  readonly requests: {
    authorization: string | undefined;
    tools: string[];
    toolResults: string[];
  }[];
  close(): Promise<void>;
}

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: { function?: { name?: string } }[];
}

interface ChatRequest {
  messages?: ChatMessage[];
  tools?: { function?: { name?: string } }[];
  stream?: boolean;
  model?: string;
}

type Step = { tool: string; args: object } | { text: string };

function nextStep(body: ChatRequest): Step {
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? "");
  const called = (body.messages ?? []).flatMap((m) =>
    (m.tool_calls ?? []).map((c) => c.function?.name ?? ""),
  );
  const manageCalls = called.filter((t) => t === "skill_manage").length;
  // Adversarial probes first: try to create a new skill, then to edit the mounted one.
  if (tools.includes("skill_manage") && manageCalls === 0) {
    return {
      tool: "skill_manage",
      args: {
        operations: [
          {
            action: "create",
            name: "spike-agent-written-skill",
            content:
              "---\nname: spike-agent-written-skill\ndescription: written by the agent\n---\nbody\n",
          },
        ],
      },
    };
  }
  if (tools.includes("skill_manage") && manageCalls === 1) {
    return {
      tool: "skill_manage",
      args: {
        operations: [
          {
            action: "patch",
            name: "spike-stage-report",
            old_string: "MARKER_K7Q2",
            new_string: "HACKED_0000",
          },
        ],
      },
    };
  }
  const skillView = tools.find((t) => t === "skill_view");
  const complete = tools.find((t) => t.endsWith("complete_stage"));
  if (skillView && !called.includes(skillView))
    return { tool: skillView, args: { name: "spike-stage-report" } };
  if (complete && !called.includes(complete)) {
    return {
      tool: complete,
      args: {
        stage: "SCAN",
        outcome: "DONE",
        candidates: [{ asset: "WMON", thesisCode: "MARKER_K7Q2", confidenceBps: 5000 }],
      },
    };
  }
  return { text: "DONE" };
}

export async function startMockModel(): Promise<MockModel> {
  const requests: MockModel["requests"] = [];
  let seq = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://mock").pathname;
      if (path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({ object: "list", data: [{ id: "scan-cheap", object: "model" }] }),
        );
      }
      if (!path.endsWith("/chat/completions")) {
        res.writeHead(404);
        return res.end();
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as ChatRequest;
      requests.push({
        authorization: req.headers.authorization,
        tools: (body.tools ?? []).map((t) => t.function?.name ?? ""),
        toolResults: (body.messages ?? [])
          .filter((m) => m.role === "tool")
          .map((m) =>
            (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 300),
          ),
      });
      const step = nextStep(body);
      const id = `mock-${(seq += 1)}`;
      const message =
        "tool" in step
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call-${id}`,
                  type: "function",
                  function: { name: step.tool, arguments: JSON.stringify(step.args) },
                },
              ],
            }
          : { role: "assistant", content: step.text };
      const finish = "tool" in step ? "tool_calls" : "stop";
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta =
          "tool" in step
            ? {
                role: "assistant",
                tool_calls: message.tool_calls?.map((c, index) => ({ index, ...c })),
              }
            : { role: "assistant", content: step.text };
        const base = {
          id,
          object: "chat.completion.chunk",
          created: 0,
          model: body.model ?? "scan-cheap",
        };
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`,
        );
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created: 0,
          model: body.model ?? "scan-cheap",
          choices: [{ index: 0, message, finish_reason: finish }],
          usage,
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
