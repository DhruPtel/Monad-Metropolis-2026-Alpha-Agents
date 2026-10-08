"use client";

import {
  OWNER_LIMIT_FIELDS,
  type OwnerLimitField,
  PLAN_CHANGE_MODES,
  REASONING_MODELS,
  REASONING_MODEL_FACTS,
  RESEARCH_INTENSITIES,
  RESEARCH_INTENSITY_FACTS,
  RISK_PRESETS,
  RISK_PRESET_FACTS,
  STRATEGY_TEMPLATES,
  TEMPLATE_FACTS,
  formatAmount,
} from "@alpha-agents/domain";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ChoiceGroup,
  CostPreview,
  EffectiveLimits,
  EmptyState,
  Field,
  GoalSaveStatus,
  GoalSummary,
  Input,
  LimitField,
  Skeleton,
  bpsText,
} from "@alpha-agents/ui";
import { ArrowLeft, PlugZap, ShieldOff, Wallet } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useWalletSession } from "@/auth/session";
import { goalChanged, limitValue } from "@/agent/goal";
import { useGoal } from "@/agent/use-goal";

/**
 * The Goal page (P3-U1, D-295): the owner tells the agent what they want
 * through structured fields only. Every field says what it does; the limits
 * that apply and a month's research cost update as the owner edits, from the
 * same translator the save uses; saving moves the agent from Not configured to
 * Ready and says so.
 */

const usdc = (e6: string | bigint) =>
  formatAmount(BigInt(e6), 6, { minFractionDigits: 2, maxFractionDigits: 2 });

const PLAN_CHANGE_TEXT = {
  ASK_FIRST: {
    title: "Ask me first",
    description: "The agent proposes each plan change and waits for your approval.",
  },
  APPLY_AND_TELL: {
    title: "Apply and tell me",
    description: "A plan change that passes every check applies at once, and you are told.",
  },
} as const;

function Section({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">{children}</CardContent>
    </Card>
  );
}

export function GoalPage({ agentId }: { agentId: bigint }) {
  const wallet = useWalletSession();
  const g = useGoal(agentId);
  const name = `Agent #${agentId.toString()}`;

  const header = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-foreground-muted">
        <Link href="/agents" className="flex items-center gap-1">
          <ArrowLeft aria-hidden className="size-4" /> My Agents
        </Link>
        <Link href={`/agents/${agentId.toString()}/portfolio`}>Portfolio</Link>
      </div>
      <h1 className="text-2xl font-semibold">{name}: goal</h1>
      <p className="max-w-2xl text-sm text-foreground-muted">
        Tell {name} what you want. Every choice here is a setting, not a message: the agent reads it
        as its goal, and the platform holds it to the limits you set.
      </p>
    </div>
  );

  if (!wallet.ready && wallet.state !== "wrong-chain")
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState
          icon={Wallet}
          title="Connect your wallet"
          description="The goal appears once you connect the wallet that owns this agent."
          action={
            <Button onClick={wallet.connect}>
              <Wallet aria-hidden /> Connect wallet
            </Button>
          }
        />
      </div>
    );
  if (wallet.state === "wrong-chain")
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState
          icon={PlugZap}
          title={`Switch to ${wallet.target.name}`}
          description="Your wallet is on another network. Switch it to set this agent's goal."
          action={<Button onClick={wallet.switchChain}>Switch network</Button>}
        />
      </div>
    );
  if (g.notOwner)
    return (
      <div className="flex flex-col gap-6" data-testid="goal-not-owner">
        {header}
        <EmptyState
          icon={ShieldOff}
          title={`This wallet does not own ${name}`}
          description="Only the agent's owner can read or change its goal. Connect the wallet that owns it."
          action={
            <Button asChild variant="secondary">
              <Link href="/agents">Go to My Agents</Link>
            </Button>
          }
        />
      </div>
    );
  if (!g.page || !g.form)
    return (
      <div className="flex flex-col gap-6">
        {header}
        {g.error ? (
          <EmptyState icon={PlugZap} title="Could not read this goal" description={g.error} />
        ) : (
          <div aria-busy="true" aria-label="Loading the goal" className="flex flex-col gap-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}
      </div>
    );

  const { page, form, preview, fieldErrors: errors } = g;
  const set = g.setForm;
  const busy = g.saving;
  const ownerLimits = Object.fromEntries(
    OWNER_LIMIT_FIELDS.map((f) => [f, limitValue(f, form.limits[f]) ?? null]),
  ) as Record<OwnerLimitField, number | null>;
  const intensityFacts = page.form.intensities;
  const costRows = RESEARCH_INTENSITIES.map((intensity) => {
    const chosenBudget =
      intensity === form.intensity && preview ? BigInt(preview.research.dailyBudgetUsdcE6) : null;
    const facts = intensityFacts.find((i) => i.id === intensity);
    return {
      intensity,
      dailyBudgetUsdcE6: chosenBudget ?? BigInt(facts?.defaultDailyBudgetUsdcE6 ?? "0"),
    };
  });
  const chosenIntensity = intensityFacts.find((i) => i.id === form.intensity);
  const changed = goalChanged(form, page.goal);

  return (
    <div className="flex flex-col gap-6" data-testid="goal-page">
      {header}
      <GoalSummary
        state={page.state}
        template={page.goal?.template ?? null}
        riskPreset={page.goal?.riskPreset ?? null}
      />

      <Section
        title="Strategy"
        description="How the agent manages the account: the plan it follows and how much risk it may take."
        testId="goal-strategy"
      >
        <ChoiceGroup
          legend="Strategy template"
          hint="The plan the agent follows. It changes the plan's numbers; a separate runner makes the trades."
          value={form.template}
          onValueChange={(v) => set((f) => ({ ...f, template: v }))}
          columns={2}
          disabled={busy}
          options={STRATEGY_TEMPLATES.map((id) => ({
            value: id,
            title: TEMPLATE_FACTS[id].label,
            description: TEMPLATE_FACTS[id].explanation,
            ...(id === "dca@1" ? { note: "Available later", disabled: true } : {}),
          }))}
        />
        <ChoiceGroup
          legend="Risk preset"
          hint="How much of the account the agent may keep in WMON, where it starts, and how far the share may drift before it trades back."
          value={form.riskPreset}
          onValueChange={(v) => set((f) => ({ ...f, riskPreset: v }))}
          disabled={busy}
          options={RISK_PRESETS.map((id) => {
            const p = RISK_PRESET_FACTS[id];
            return {
              value: id,
              title: p.label,
              detail: `WMON ${bpsText(p.targetMinBps)} to ${bpsText(p.targetMaxBps)}, starts at ${bpsText(p.defaultTargetBps)}, band ±${bpsText(p.bandHalfWidthBps)}`,
            };
          })}
        />
        <ChoiceGroup
          legend="Allowed assets"
          hint="USDC is always allowed. Turning WMON off keeps the whole account in USDC."
          value={form.wmon ? "WMON" : "USDC"}
          onValueChange={(v) => set((f) => ({ ...f, wmon: v === "WMON" }))}
          columns={2}
          disabled={busy}
          options={[
            { value: "WMON", title: "USDC and WMON", description: "The agent may hold WMON." },
            { value: "USDC", title: "USDC only", description: "The agent holds no WMON." },
          ]}
        />
        {preview ? (
          <p className="text-sm text-foreground-muted" data-testid="goal-plan-line">
            The plan starts at{" "}
            <span className="numeric text-foreground">
              {bpsText(preview.template.params.targetWmonBps)}
            </span>{" "}
            WMON and may move between{" "}
            <span className="numeric text-foreground">{bpsText(preview.targetRange.minBps)}</span>{" "}
            and{" "}
            <span className="numeric text-foreground">{bpsText(preview.targetRange.maxBps)}</span>,
            within your limits below.
          </p>
        ) : null}
      </Section>

      <Section
        title="Stricter limits"
        description="Optional. Each one can only tighten the platform's hard limit, never loosen it."
        testId="goal-limits"
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {page.form.limits.map((l) => {
            const error = errors[`stricterLimits.${l.field}`];
            return (
              <LimitField
                key={l.field}
                field={l.field}
                hard={l.hard}
                valueText={form.limits[l.field]}
                onChange={(text) =>
                  set((f) => ({ ...f, limits: { ...f.limits, [l.field]: text } }))
                }
                disabled={busy}
                {...(error ? { error } : {})}
              />
            );
          })}
        </div>
        <EffectiveLimits
          hard={page.form.hardLimits}
          owner={ownerLimits}
          refused={OWNER_LIMIT_FIELDS.filter((f) => errors[`stricterLimits.${f}`] !== undefined)}
          effective={preview?.ownerLimits ?? page.form.hardLimits}
        />
      </Section>

      <Section
        title="Research"
        description="How the agent researches, and the most it may spend on it. Research is paid from credits."
        testId="goal-research"
      >
        <ChoiceGroup
          legend="Reasoning model"
          hint="The model for deep research, the skeptic's check and the plan review. Scans use a cheaper model."
          value={form.reasoningModel}
          onValueChange={(v) => set((f) => ({ ...f, reasoningModel: v }))}
          columns={2}
          disabled={busy}
          options={REASONING_MODELS.map((id) => ({
            value: id,
            title: `${REASONING_MODEL_FACTS[id].label}: ${REASONING_MODEL_FACTS[id].model}`,
            description:
              id === "STANDARD"
                ? "Careful and economical; the default."
                : "Deeper reasoning; each research stage can cost about twice as much.",
            ...(id === "STANDARD" ? { note: "Default" } : {}),
          }))}
        />
        <ChoiceGroup
          legend="Research intensity"
          hint="How often the agent researches. More research costs more each day."
          value={form.intensity}
          onValueChange={(v) => set((f) => ({ ...f, intensity: v }))}
          disabled={busy}
          options={RESEARCH_INTENSITIES.map((id) => {
            const f = RESEARCH_INTENSITY_FACTS[id];
            const facts = intensityFacts.find((i) => i.id === id);
            return {
              value: id,
              title: f.label,
              ...(id === "LIGHT" ? { note: "Default" } : {}),
              description: `A Scan every ${f.scanEveryHours} hours, up to ${f.divesPerDay} Dive${f.divesPerDay === 1 ? "" : "s"} a day.`,
              detail: `${usdc(facts?.defaultDailyBudgetUsdcE6 ?? "0")} USDC a day, at most ${usdc(facts?.monthlyAtDefaultUsdcE6 ?? "0")} a month`,
            };
          })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Daily research budget (USDC)"
            hint={`The most research may spend in a day; a stage that would go past it waits for the next day. At ${RESEARCH_INTENSITY_FACTS[form.intensity].label}: ${usdc(chosenIntensity?.minDailyBudgetUsdcE6 ?? "0")} to ${usdc(chosenIntensity?.maxDailyBudgetUsdcE6 ?? "0")}.`}
            {...(errors["research.dailyBudgetUsdcE6"]
              ? { error: errors["research.dailyBudgetUsdcE6"] }
              : {})}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                value={form.budgetText}
                disabled={busy}
                onChange={(e) => set((f) => ({ ...f, budgetText: e.target.value }))}
                data-testid="goal-budget"
              />
            )}
          </Field>
          <Field
            label="Credit reserve (USDC)"
            hint={`Credits research never spends, kept for the agent's gas. 0.00 to ${usdc(page.form.maxCreditReserveUsdcE6)}.`}
            {...(errors.creditReserveUsdcE6 ? { error: errors.creditReserveUsdcE6 } : {})}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                value={form.reserveText}
                disabled={busy}
                onChange={(e) => set((f) => ({ ...f, reserveText: e.target.value }))}
                data-testid="goal-reserve"
              />
            )}
          </Field>
        </div>
        <CostPreview
          rows={costRows}
          selected={form.intensity}
          days={page.form.costPreviewDays}
          sweepMaxUsdcE6={BigInt(page.form.sweepMaxUsdcE6[form.reasoningModel])}
        />
      </Section>

      <Section
        title="Plan changes"
        description="When the agent finds a reason to change its plan, what happens next."
        testId="goal-plan-changes"
      >
        <ChoiceGroup
          legend="Plan changes"
          hint="Either way, a change must pass every check first: your limits, a 24-hour cooldown and its cost."
          value={form.planChanges}
          onValueChange={(v) => set((f) => ({ ...f, planChanges: v }))}
          columns={2}
          disabled={busy}
          options={PLAN_CHANGE_MODES.map((id) => ({
            value: id,
            ...PLAN_CHANGE_TEXT[id],
            ...(id === "ASK_FIRST" ? { note: "Default" } : {}),
          }))}
        />
      </Section>

      <div className="flex flex-col gap-3" data-testid="goal-save">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={g.save} loading={busy} disabled={busy || !changed}>
            {page.goal ? "Save changes" : "Save goal"}
          </Button>
          <span className="text-sm text-foreground-muted">
            {page.goal
              ? changed
                ? "Saving a change starts a new plan period; trades proposed before it are not sent."
                : "No changes to save."
              : "Saving moves the agent from Not configured to Ready."}
          </span>
        </div>
        {g.status ? (
          <GoalSaveStatus state={g.status.state} text={g.status.text} reasons={g.status.reasons} />
        ) : null}
      </div>
    </div>
  );
}
