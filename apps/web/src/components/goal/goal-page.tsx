"use client";

import { AGGRESSIVENESS_ENVELOPES, type GoalAllocation } from "@alpha-agents/domain";
import {
  AllocationSliders,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChoiceGroup,
  EmptyState,
  ExpandableLine,
  GoalPreviewCard,
  GoalSaveStatus,
  LimitField,
  Skeleton,
  Slider,
  StyleTiles,
  Tag,
  WalletActionStatus,
} from "@alpha-agents/ui";
import type { EnvironmentId } from "@alpha-agents/config";
import { PlugZap, ShieldOff, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { useWalletSession } from "@/auth/session";
import { type AllocationKey, goalChanged, rebalanceAllocation, withStyle } from "@/agent/goal";
import { useAccountTx } from "@/agent/use-account-tx";
import { useGoal } from "@/agent/use-goal";

/**
 * The Set goal page (2026-10-13, rebuilt after the owner's model of a compact
 * launch form): a main column of short cards, the style as three square tiles,
 * the allocation split by market cap, the most positions, and Safety, Plan
 * changes and Stricter limits folded to one line each; on the right, a live
 * preview with the save. The research settings live on the Research tab.
 * Fields the page no longer shows (excluded tokens, the other stricter limits)
 * keep their saved values.
 */

const STYLE_LINE = {
  CONSERVATIVE: "Top assets, few positions.",
  BALANCED: "Top assets plus researched growth.",
  AGGRESSIVE: "Small caps too, larger swings.",
} as const;

const ALLOCATION_ROWS: readonly { key: AllocationKey; label: string; line: string }[] = [
  { key: "degenBps", label: "Degen", line: "Tokens under $100M market cap." },
  { key: "growthBps", label: "Growth", line: "Tokens from $100M to $1B." },
  { key: "conservativeBps", label: "Conservative", line: "Top assets." },
];

const PLAN_CHANGE_WORDS = {
  ASK_FIRST: "Ask me first",
  APPLY_AND_TELL: "Apply and tell me",
} as const;

/** How long the saved message shows before the page returns to where the owner came from. */
const RETURN_AFTER_MS = 1_500;

const split = (a: GoalAllocation) =>
  `${a.degenBps / 100}% / ${a.growthBps / 100}% / ${a.conservativeBps / 100}%`;

function Block({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <Card data-testid={testId} id={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

export function GoalPage({
  environment,
  agentId,
}: {
  environment: EnvironmentId;
  agentId: bigint;
}) {
  const wallet = useWalletSession();
  const g = useGoal(agentId);
  const router = useRouter();
  const name = `Agent #${agentId.toString()}`;
  // F-U12: the screened-lane opt-in recorded on the agent's account from the owner's wallet.
  const tx = useAccountTx(environment);
  const [recorded, setRecorded] = useState<boolean | null>(null);

  // Back to where the owner came from once the goal is saved.
  const saved = g.status?.state === "saved";
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => {
      if (window.history.length > 1) router.back();
      else router.push(`/agents/${agentId.toString()}`);
    }, RETURN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [agentId, router, saved]);

  const header = <h2 className="text-lg font-semibold">Set goal</h2>;

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

  const { page, form, fieldErrors: errors } = g;
  const set = g.setForm;
  const busy = g.saving;
  const changed = goalChanged(form, page.goal);
  const styleMax = AGGRESSIVENESS_ENVELOPES[form.aggressiveness].maxPositions;

  const chain = page.chain;
  const onChain = recorded ?? chain?.screenedOptIn ?? null;
  const wanted = form.screenedOptIn;
  const recordOnChain = () => {
    const account = chain?.account;
    if (!account) return;
    void tx
      .send(
        wanted ? "Record the opt-in on chain" : "Record the opt-out on chain",
        account,
        { functionName: "setScreenedOptIn", args: [wanted] },
        wanted ? "Your opt-in is recorded on chain." : "Your opt-out is recorded on chain.",
      )
      .then((p) => {
        if (p?.state === "confirmed") setRecorded(wanted);
      });
  };
  const limitField = (field: "maxTradesPer24h" | "maxTradeBps") => {
    const l = page.form.limits.find((x) => x.field === field);
    if (!l) return null;
    const error = errors[`stricterLimits.${field}`];
    return (
      <LimitField
        key={field}
        field={field}
        hard={l.hard}
        valueText={form.limits[field]}
        onChange={(text) => set((f) => ({ ...f, limits: { ...f.limits, [field]: text } }))}
        disabled={busy}
        {...(error ? { error } : {})}
      />
    );
  };
  const stricter = [form.limits.maxTradesPer24h, form.limits.maxTradeBps].filter(
    (t) => t.trim() !== "",
  ).length;

  return (
    <div className="flex flex-col gap-6" data-testid="goal-page">
      {header}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <Block title="Style" testId="goal-style">
            <StyleTiles
              value={form.aggressiveness}
              onValueChange={(v) => set((f) => withStyle(f, v))}
              disabled={busy}
              tiles={page.form.levels.map((l) => ({
                value: l.id,
                title: l.label,
                line: STYLE_LINE[l.id],
              }))}
            />
          </Block>

          <Block title="Allocation" testId="goal-allocation">
            <AllocationSliders
              disabled={busy}
              rows={ALLOCATION_ROWS.map((r) => ({ ...r, bps: form.allocation[r.key] }))}
              onChange={(key, bps) =>
                set((f) => ({
                  ...f,
                  allocation: rebalanceAllocation(f.allocation, key as AllocationKey, bps),
                }))
              }
            />
            {errors.allocation ? (
              <p className="text-sm text-negative">{errors.allocation}</p>
            ) : null}
          </Block>

          <Block title="Positions" testId="goal-positions">
            <ExpandableLine
              summary={
                <span data-testid="goal-positions-line">
                  Up to {form.maxPositions} positions. The agent decides each one&apos;s weight.
                </span>
              }
            >
              <div className="flex flex-col gap-2">
                <Slider
                  thumbLabel="Most positions"
                  min={1}
                  max={styleMax}
                  step={1}
                  value={[form.maxPositions]}
                  disabled={busy}
                  onValueChange={(v) =>
                    set((f) => ({ ...f, maxPositions: v[0] ?? f.maxPositions }))
                  }
                />
                <span className="text-xs text-foreground-muted">
                  1 to {styleMax} for this style.
                </span>
              </div>
            </ExpandableLine>
          </Block>

          <ExpandableLine
            summary={
              <span data-testid="goal-safety-line">
                Safety: screened tokens {form.screenedOptIn ? "on" : "off"}
              </span>
            }
          >
            <div className="flex flex-col gap-3" data-testid="goal-safety">
              <ChoiceGroup
                legend="Screened tokens"
                hint="Tokens that passed the platform's safety screen, beside the core list. Holding them also needs your onchain opt-in."
                value={form.screenedOptIn ? "ON" : "OFF"}
                onValueChange={(v) => set((f) => ({ ...f, screenedOptIn: v === "ON" }))}
                columns={2}
                disabled={busy}
                options={[
                  { value: "OFF", title: "Off", description: "Core list only." },
                  { value: "ON", title: "On", description: "Screened tokens too." },
                ]}
              />
              <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="goal-onchain">
                <span className="text-foreground-muted">On chain</span>
                {chain?.account ? (
                  <Tag tone={onChain ? "accent" : "neutral"}>
                    {onChain ? "opted in" : "not opted in"}
                  </Tag>
                ) : (
                  <Tag>no account yet</Tag>
                )}
                {chain?.account && onChain !== wanted ? (
                  <Button size="sm" variant="secondary" disabled={tx.busy} onClick={recordOnChain}>
                    {wanted ? "Record the opt-in" : "Record the opt-out"}
                  </Button>
                ) : null}
              </div>
              {tx.progress && tx.text ? (
                <WalletActionStatus
                  state={tx.progress.state}
                  text={tx.text}
                  hash={tx.progress.hash ?? null}
                />
              ) : null}
            </div>
          </ExpandableLine>

          <ExpandableLine
            summary={
              <span data-testid="goal-plan-changes-line">
                Plan changes: {PLAN_CHANGE_WORDS[form.planChanges]}
              </span>
            }
          >
            <ChoiceGroup
              legend="Plan changes"
              hint="Either way, a change passes every check first."
              value={form.planChanges}
              onValueChange={(v) => set((f) => ({ ...f, planChanges: v }))}
              columns={2}
              disabled={busy}
              options={[
                { value: "ASK_FIRST", title: "Ask me first", description: "You approve each one." },
                {
                  value: "APPLY_AND_TELL",
                  title: "Apply and tell me",
                  description: "It applies, then you're told.",
                },
              ]}
            />
          </ExpandableLine>

          <ExpandableLine
            summary={
              <span data-testid="goal-limits-line">
                Stricter limits (optional): {stricter === 0 ? "none" : `${stricter} set`}
              </span>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2" data-testid="goal-limits">
              {limitField("maxTradesPer24h")}
              {limitField("maxTradeBps")}
            </div>
          </ExpandableLine>
        </div>

        <aside className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
          <GoalPreviewCard
            rows={[
              {
                label: "Style",
                value:
                  page.form.levels.find((l) => l.id === form.aggressiveness)?.label ??
                  form.aggressiveness,
              },
              { label: "Degen / Growth / Conservative", value: split(form.allocation) },
              { label: "Positions", value: `Up to ${form.maxPositions}` },
              {
                label: "Safety",
                value: form.screenedOptIn ? "Screened tokens on" : "Core list only",
              },
              { label: "Plan changes", value: PLAN_CHANGE_WORDS[form.planChanges] },
            ]}
            note={
              page.goal
                ? form.planChanges === "ASK_FIRST"
                  ? "Saving starts a new plan: the agent's next research run makes one under this goal and asks you before it trades."
                  : "Saving starts a new plan: the agent's next research run makes one under this goal and applies it, then tells you."
                : "Saving sets the agent's first goal; its first research run makes the plan."
            }
            action={
              <Button
                onClick={g.save}
                loading={busy}
                disabled={busy || !changed}
                data-testid="goal-save"
              >
                {changed ? "Save" : "No changes"}
              </Button>
            }
            status={
              g.status ? (
                <GoalSaveStatus
                  state={g.status.state}
                  text={saved ? `${g.status.text} Taking you back.` : g.status.text}
                  reasons={g.status.reasons}
                />
              ) : null
            }
          />
        </aside>
      </div>
    </div>
  );
}
