"use client";

import {
  Badge,
  Button,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@alpha-agents/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  checkPortfolioPlanAction,
  runRunnerAction,
  setPlanAction,
  setPortfolioPlanAction,
} from "./actions";
import { type PlanFinding, type PlanParams, type PlanView, isPortfolioPlanView } from "./extension";
import {
  type PortfolioDraft,
  draftTotalPercent,
  emptyPosition,
  portfolioDraftOf,
  toPortfolioParams,
} from "./portfolio-plan";

/**
 * The console's plan form (P3-U3, F-U6): the two-asset bands' parameters in
 * the units an owner reads (percent, points, USDC, bps), prefilled from the
 * active plan or the goal's defaults; or, for an agent on the fund agent's
 * set, a target portfolio: positions with a token, a weight, a band, a thesis
 * and an exit plan, plus the cash target. "Check plan" runs the Test stage
 * v2 on the draft; "Set plan" sets it (checked again) and bumps the strategy
 * epoch; "Run now" runs the runner for this agent once (local).
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

/** The portfolio's shared fields (the same meaning as the bands'), in the same units. */
const SHARED: readonly {
  key: keyof Omit<PortfolioDraft, "positions">;
  label: string;
  hint: string;
}[] = [
  { key: "cash", label: "Cash target (% USDC)", hint: "Weights and cash add up to 100%" },
  { key: "minTrade", label: "Minimum trade (USDC)", hint: "Smaller legs hold" },
  {
    key: "brake",
    label: "Volatility brake (%)",
    hint: "A token's buys hold above this 24-hour volatility",
  },
  { key: "cost", label: "Cost limit (bps)", hint: "Most a leg may cost against the oracle" },
  { key: "maxLeg", label: "Largest leg (% of account)", hint: "Never above the per-trade cap" },
];

type Template = "rebalance_bands@1" | "target_portfolio@1";

export function PlanControls({
  agentId,
  name,
  plan,
  defaults,
  portfolio,
  canSet,
  canRun,
}: {
  agentId: string;
  name: string;
  plan: PlanView["plan"];
  defaults: PlanParams;
  portfolio: PlanView["portfolio"];
  canSet: boolean;
  canRun: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const active = plan && isPortfolioPlanView(plan) ? plan.params : null;
  const bandsParams = plan && !isPortfolioPlanView(plan) ? (plan.params as PlanParams) : null;
  const onV3 = Boolean(portfolio);
  const [template, setTemplate] = useState<Template>(
    active ? "target_portfolio@1" : "rebalance_bands@1",
  );
  const [draft, setDraft] = useState<Draft>(fromParams(bandsParams ?? defaults));
  const [folio, setFolio] = useState<PortfolioDraft>(portfolioDraftOf(active, defaults));
  const [findings, setFindings] = useState<PlanFinding[] | null>(null);
  const tokens = (portfolio?.tokens ?? []).filter((t) => t.symbol !== "USDC");

  const save = () =>
    start(async () => {
      if (template === "target_portfolio@1") {
        const params = toPortfolioParams(folio);
        if ("error" in params) {
          toast.error("The plan was not set", { description: params.error });
          return;
        }
        const r = await setPortfolioPlanAction(agentId, params);
        if (!r.ok) {
          toast.error("The plan was not set", { description: r.error });
          return;
        }
        toast.success(`${name}'s plan is set`, {
          description: `Strategy epoch ${r.value}: anything proposed under the previous plan will not be sent.`,
        });
        setFindings(null);
        router.refresh();
        return;
      }
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

  const check = () =>
    start(async () => {
      const params = toPortfolioParams(folio);
      if ("error" in params) {
        toast.error("The plan could not be checked", { description: params.error });
        return;
      }
      const r = await checkPortfolioPlanAction(agentId, params);
      if (!r.ok) {
        toast.error("The plan could not be checked", { description: r.error });
        return;
      }
      setFindings(r.value);
      if (r.value.length === 0) toast.success("The Test passes this plan");
      else toast.info(`The Test refuses this plan: ${r.value.map((f) => f.code).join(", ")}`);
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

  const setPosition = (i: number, patch: Partial<PortfolioDraft["positions"][number]>) =>
    setFolio((f) => ({
      ...f,
      positions: f.positions.map((p, k) => (k === i ? { ...p, ...patch } : p)),
    }));
  const total = draftTotalPercent(folio);

  return (
    <div className="flex flex-col gap-3" data-testid="plan-controls">
      {onV3 ? (
        <Field
          label="Template"
          hint="The two-asset bands, or a target portfolio over the registry's tokens"
        >
          {(control) => (
            <Select value={template} onValueChange={(v) => setTemplate(v as Template)}>
              <SelectTrigger {...control} className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rebalance_bands@1">
                  Two-asset bands (rebalance_bands@1)
                </SelectItem>
                <SelectItem value="target_portfolio@1">
                  Target portfolio (target_portfolio@1)
                </SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
      ) : null}
      {template === "target_portfolio@1" ? (
        <div className="flex flex-col gap-3" data-testid="portfolio-form">
          {folio.positions.map((p, i) => (
            <div
              key={i}
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6"
              data-testid="position-row"
            >
              <Field label={`Position ${i + 1} token`}>
                {(control) => (
                  <Select value={p.token} onValueChange={(v) => setPosition(i, { token: v })}>
                    <SelectTrigger {...control}>
                      <SelectValue placeholder="Token" />
                    </SelectTrigger>
                    <SelectContent>
                      {tokens.map((t) => (
                        <SelectItem key={t.token} value={t.token}>
                          {t.symbol} ({t.class}, {t.status.toLowerCase().replace("_", " ")}, cap{" "}
                          {t.capBps / 100}%)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Field label="Weight (%)">
                {(control) => (
                  <Input
                    {...control}
                    inputMode="decimal"
                    value={p.weight}
                    disabled={!canSet || pending}
                    onChange={(e) => setPosition(i, { weight: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Band (± points)">
                {(control) => (
                  <Input
                    {...control}
                    inputMode="decimal"
                    value={p.band}
                    disabled={!canSet || pending}
                    onChange={(e) => setPosition(i, { band: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Thesis ID">
                {(control) => (
                  <Input
                    {...control}
                    value={p.thesisId}
                    disabled={!canSet || pending}
                    onChange={(e) => setPosition(i, { thesisId: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Kill criterion">
                {(control) => (
                  <Input
                    {...control}
                    value={p.killCriterion}
                    disabled={!canSet || pending}
                    onChange={(e) => setPosition(i, { killCriterion: e.target.value })}
                  />
                )}
              </Field>
              <div className="flex items-end gap-2">
                <Field label="Recheck (date)" className="min-w-0 flex-1">
                  {(control) => (
                    <Input
                      {...control}
                      value={p.recheckAt}
                      disabled={!canSet || pending}
                      onChange={(e) => setPosition(i, { recheckAt: e.target.value })}
                    />
                  )}
                </Field>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canSet || pending || folio.positions.length === 1}
                  aria-label={`Remove position ${i + 1}`}
                  onClick={() =>
                    setFolio((f) => ({ ...f, positions: f.positions.filter((_, k) => k !== i) }))
                  }
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!canSet || pending || folio.positions.length >= 12}
              onClick={() =>
                setFolio((f) => ({ ...f, positions: [...f.positions, emptyPosition()] }))
              }
            >
              Add position
            </Button>
            <Badge tone={total === 100 ? "positive" : "warning"} data-testid="portfolio-total">
              Weights and cash: {total}%
            </Badge>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {SHARED.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint}>
                {(control) => (
                  <Input
                    {...control}
                    inputMode="decimal"
                    value={folio[f.key]}
                    disabled={!canSet || pending}
                    onChange={(e) => setFolio((d) => ({ ...d, [f.key]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
          {findings ? (
            <div className="flex flex-col gap-1 text-sm" data-testid="plan-findings">
              {findings.length === 0 ? (
                <Badge tone="positive">The Test passes this plan</Badge>
              ) : (
                findings.map((f, i) => (
                  <div key={i} className="flex flex-wrap items-baseline gap-2">
                    <Badge tone="negative">{f.code}</Badge>
                    <span className="text-foreground-muted">{f.message}</span>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>
      ) : (
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
      )}
      <div className="flex flex-wrap gap-2">
        {template === "target_portfolio@1" ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={!canSet || pending}
            loading={pending}
            onClick={check}
          >
            Check plan
          </Button>
        ) : null}
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
