import type { Hono } from "hono";
import { z } from "zod";
import type { Orchestrator } from "./orchestrator.ts";
import { BREACH_CODES, BREACH_TEXT } from "./sentinel.ts";

/**
 * The Risk Sentinel's routes (P4-U2): an agent's sentinel view for the
 * owner (through the control API) and the console; an operator's clearing
 * of a state the sentinel set, after review; and, for the dev console on
 * the local fork only, a pass now and the feed drill.
 */
export function registerSentinelRoutes(
  app: Hono,
  o: {
    orchestrator: Orchestrator;
    agentRef: (raw: string) => { chainId: number; agentId: number } | null;
    /** Clearing a state: the operator. */
    canAct: boolean;
    /** A pass now and the drills: the dev console only. */
    canDrive: boolean;
  },
): void {
  const orch = o.orchestrator;

  app.get("/v1/agents/:agentId/sentinel", async (c) => {
    const ref = o.agentRef(c.req.param("agentId"));
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    const read = await orch.sentinelRead(ref);
    return c.json({
      agentId: String(ref.agentId),
      ...read,
      breaches: BREACH_CODES.map((code) => ({ code, text: BREACH_TEXT[code] })),
      actions: read.actions.map((a) => ({
        ...a,
        text: BREACH_TEXT[a.code as keyof typeof BREACH_TEXT] ?? a.code,
      })),
    });
  });

  if (!o.canAct) return;

  /** After review: back to the agent's rest state; the account's mode is the owner's to change. */
  app.post("/v1/agents/:agentId/sentinel/clear", async (c) => {
    const ref = o.agentRef(c.req.param("agentId"));
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    return c.json({ agentId: String(ref.agentId), ...(await orch.sentinelClear(ref)) });
  });

  if (!o.canDrive) return;

  app.post("/v1/sentinel/tick", async (c) => {
    try {
      return c.json({ actions: await orch.sentinelTick() });
    } catch (err) {
      return c.json(
        { error: "sentinel_off", message: err instanceof Error ? err.message : String(err) },
        409,
      );
    }
  });

  const Feed = z.strictObject({ down: z.boolean() });
  /** The feed drill: MON/USD stalled (reverting) or restored, on the local fork only. */
  app.post("/v1/dev/market/feed", async (c) => {
    const body = Feed.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success)
      return c.json({ error: "bad_request", message: "down must be a boolean" }, 400);
    try {
      return c.json(await orch.stallMarket(body.data.down));
    } catch (err) {
      return c.json(
        { error: "drill_off", message: err instanceof Error ? err.message : String(err) },
        409,
      );
    }
  });
}
