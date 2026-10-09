import { SCREEN_CHECK_LABELS, SCREEN_RULES } from "@alpha-agents/domain";
import type { Hono } from "hono";
import { z } from "zod";
import { RegistryError, type TokenRegistry } from "./tokens/registry.ts";
import { poolItem } from "./tokens/tool-source.ts";

/**
 * The console's token routes (F-U1): the registry with each token's class,
 * liquidity, pool age and latest screen; one token in full with its pools and
 * its screen history, every check with its reason and evidence; the newest
 * pools; and, where operator actions exist, screening a token or running
 * discovery now. A platform read charges nothing. The orchestrator's API is
 * loopback-only (D-205).
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const TokenListQuery = z.strictObject({
  priceClass: z.enum(["F", "A"]).optional(),
  screen: z.enum(["passed", "refused", "unscreened", "expired"]).optional(),
  minLiquidityUsd: z.coerce.number().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function registerTokenRoutes(
  app: Hono,
  o: { readonly registry: TokenRegistry | null; readonly canAct: boolean },
): void {
  app.get("/v1/tokens", async (c) => {
    const r = o.registry;
    if (!r) return c.json({ configured: false }, 503);
    const q = TokenListQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "bad_query" }, 400);
    const [tokens, counts, runs] = await Promise.all([
      r.list({
        ...(q.data.priceClass ? { priceClass: q.data.priceClass } : {}),
        ...(q.data.screen ? { screen: q.data.screen } : {}),
        ...(q.data.minLiquidityUsd === undefined
          ? {}
          : { minLiquidityUsd: q.data.minLiquidityUsd }),
        limit: q.data.limit ?? 200,
      }),
      r.store.counts(r.chainId),
      r.store.runs(r.chainId, 5),
    ]);
    return c.json({
      configured: r.configured,
      rules: SCREEN_RULES,
      labels: SCREEN_CHECK_LABELS,
      counts,
      runs,
      tokens,
      canAct: o.canAct,
    });
  });

  app.get("/v1/tokens/pools/new", async (c) => {
    const r = o.registry;
    if (!r) return c.json({ configured: false }, 503);
    const hours = Number(c.req.query("hours") ?? 72);
    if (![24, 72, 168].includes(hours)) return c.json({ error: "bad_hours" }, 400);
    const now = Date.now();
    return c.json({ hours, pools: (await r.newPools(hours, 50)).map((p) => poolItem(p, now)) });
  });

  app.get("/v1/tokens/:address", async (c) => {
    const r = o.registry;
    if (!r) return c.json({ configured: false }, 503);
    const address = c.req.param("address");
    if (!ADDRESS.test(address)) return c.json({ error: "bad_address" }, 400);
    const token = await r.store.token(r.chainId, address);
    if (!token) return c.json({ error: "not_found" }, 404);
    const [pools, screens] = await Promise.all([
      r.store.poolsOf(r.chainId, address),
      r.store.screens(r.chainId, address, 10),
    ]);
    const now = Date.now();
    return c.json({
      token,
      pools: pools.map((p) => poolItem(p, now)),
      screens,
      labels: SCREEN_CHECK_LABELS,
      canAct: o.canAct,
    });
  });

  if (!o.canAct) return;

  /** Screen a token now, on the screen fork; the console waits for the result. */
  app.post("/v1/tokens/:address/screen", async (c) => {
    const r = o.registry;
    if (!r) return c.json({ configured: false }, 503);
    const address = c.req.param("address");
    if (!ADDRESS.test(address)) return c.json({ error: "bad_address" }, 400);
    try {
      return c.json({ screen: await r.screen(address, "console") });
    } catch (err) {
      if (err instanceof RegistryError)
        return c.json(
          { error: err.code.toLowerCase(), message: err.message },
          err.code === "NOT_FOUND" ? 404 : 503,
        );
      throw err;
    }
  });

  /** Run a discovery pass now. */
  app.post("/v1/tokens/discover", async (c) => {
    const r = o.registry;
    if (!r) return c.json({ configured: false }, 503);
    try {
      return c.json({ discovery: await r.discover() });
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 300) : "discovery failed";
      return c.json({ error: "discovery_failed", message }, 503);
    }
  });
}
