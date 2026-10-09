"use client";

import { Button, Field, Input, toast } from "@alpha-agents/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { runRunnerAction, setPlanAction } from "./actions";
import type { PlanParams } from "./extension";

/**
 * The console's plan form (P3-U3): rebalance_bands@1's parameters in the
 * units an owner reads (percent, points, USDC, bps), prefilled from the active
 * plan or the goal's defaults; "Set plan" checks it against the goal and bumps
 * the strategy epoch; "Run now" runs the runner for this agent once (local).
 */
interface Draft {
  target: string;
  band: string;
  minTrade: string;
  brake: string;
  cost: string;
  maxLeg: string;
}

const fromParams = (p: PlanParams): Draft => ({
  target: String(p.targetWmonBps / 100),
  band: String(p.bandHalfWidthBps / 100),
  minTrade: String(Number(p.minTradeUsdcE6) / 1_000_000),
  brake: String(p.volatilityBrakeBps / 100),
  cost: String(p.costHurdleBps),
  maxLeg: String(p.maxLegBps / 100),
});

/** The draft as the API's parameters, or the first field that is not a number. */
export function toParams(d: Draft): PlanParams | { error: string } {
  const num = (v: string, label: string) => {
    const n = Number(v);
    if (v.trim() === "" || !Number.isFinite(n) || n < 0)
      throw new Error(`${label} must be a number of 0 or more.`);
    return n;
  };
  try {
    return {
      targetWmonBps: Math.round(num(d.target, "Target WMON share") * 100),
      bandHalfWidthBps: Math.round(num(d.band, "Band") * 100),
      minTradeUsdcE6: String(Math.round(num(d.minTrade, "Minimum trade") * 1_000_000)),
      volatilityBrakeBps: Math.round(num(d.brake, "Volatility brake") * 100),
      costHurdleBps: Math.round(num(d.cost, "Cost limit")),
      maxLegBps: Math.round(num(d.maxLeg, "Largest leg") * 100),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const FIELDS: readonly { key: keyof Draft; label: string; hint: string }[] = [
  { key: "target", label: "Target WMON share (%)", hint: "Inside the goal's range" },
  {
    key: "band",
    label: "Band (± points)",
    hint: "No trade while the share is this close to the target",
  },
  { key: "minTrade", label: "Minimum trade (USDC)", hint: "Smaller legs hold" },
  { key: "brake", label: "Volatility brake (%)", hint: "Buys hold above this 24-hour volatility" },
  { key: "cost", label: "Cost limit (bps)", hint: "Most a leg may cost against the oracle" },
  {
    key: "maxLeg",
    label: "Largest leg (% of account)",
    hint: "Never above the owner's largest trade",
  },
];

export function PlanControls({
  agentId,
  name,
  initial,
  canSet,
  canRun,
}: {
  agentId: string;
  name: string;
  initial: PlanParams;
  canSet: boolean;
  canRun: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Draft>(fromParams(initial));

  const save = () =>
    start(async () => {
      const params = toParams(draft);
      if ("error" in params) {
        toast.error("The plan was not set", { description: params.error });
        return;
      }
      const r = await setPlanAction(agentId, params);
      if (!r.ok) {
        toast.error("The plan was not set", { description: r.error });
        return;
      }
      toast.success(`${name}'s plan is set`, {
        description: `Strategy epoch ${r.value}: anything proposed under the previous plan will not be sent.`,
      });
      router.refresh();
    });

  const run = () =>
    start(async () => {
      const r = await runRunnerAction(agentId);
      if (!r.ok) {
        toast.error("The runner did not run", { description: r.error });
        return;
      }
      if (r.value.outcome === "leg")
        toast.success("The runner proposed a leg", { description: r.value.message });
      else toast.info(`The runner holds: ${r.value.code}`, { description: r.value.message });
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-3" data-testid="plan-controls">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                value={draft[f.key]}
                disabled={!canSet || pending}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            )}
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={!canSet || pending}
          loading={pending}
          onClick={save}
        >
          Set plan
        </Button>
        <Button size="sm" variant="secondary" disabled={!canRun || pending} onClick={run}>
          Run now
        </Button>
      </div>
    </div>
  );
}
