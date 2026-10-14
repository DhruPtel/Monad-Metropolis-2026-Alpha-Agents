"use client";

import {
  type ModelTier,
  RESEARCH_INTENSITIES,
  RESEARCH_INTENSITY_FACTS,
  type ResearchIntensity,
} from "@alpha-agents/domain";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  GoalSaveStatus,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  usdcCents as usdc,
} from "@alpha-agents/ui";
import Image from "next/image";
import { goalChanged } from "@/agent/goal";
import { useGoal } from "@/agent/use-goal";

/**
 * The Research tab's settings (2026-10-13, moved from the Set goal page): the
 * model tier, how often research runs, its daily budget and the credit
 * reserve, saved with the goal through the same save. A save changes the goal,
 * so the agent's next research run makes a new plan.
 */
export function ResearchSettings({ agentId }: { agentId: bigint }) {
  const g = useGoal(agentId);
  if (!g.page || !g.form) return null;
  const { page, form, fieldErrors: errors } = g;
  const set = g.setForm;
  const busy = g.saving;
  const changed = goalChanged(form, page.goal);
  const facts = page.form.intensities.find((i) => i.id === form.intensity);
  return (
    <Card data-testid="research-settings">
      <CardHeader>
        <CardTitle>Research settings</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Model tier">
            {(control) => (
              <Select
                value={form.modelTier}
                onValueChange={(v) => set((f) => ({ ...f, modelTier: v as ModelTier }))}
                disabled={busy}
              >
                <SelectTrigger {...control} data-testid="research-settings-tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {page.form.tiers.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      <span className="flex items-center gap-2">
                        {/* 2026-10-13: the owner's intelligence icons (public/icons/intelligence). */}
                        <Image
                          src={`/icons/intelligence/${t.id.toLowerCase()}.svg`}
                          alt=""
                          width={20}
                          height={20}
                          className="size-5"
                        />
                        {t.label}: {t.model}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label="How often">
            {(control) => (
              <Select
                value={form.intensity}
                onValueChange={(v) => set((f) => ({ ...f, intensity: v as ResearchIntensity }))}
                disabled={busy}
              >
                <SelectTrigger {...control} data-testid="research-settings-intensity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESEARCH_INTENSITIES.map((id) => {
                    const f = RESEARCH_INTENSITY_FACTS[id];
                    return (
                      <SelectItem key={id} value={id}>
                        {f.label}: a Scan every {f.scanEveryHours} h
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field
            label="Daily budget (USDC)"
            hint={`${usdc(facts?.minDailyBudgetUsdcE6 ?? "0")} to ${usdc(facts?.maxDailyBudgetUsdcE6 ?? "0")}`}
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
              />
            )}
          </Field>
          <Field
            label="Credit reserve (USDC)"
            hint="Kept for the agent's gas."
            {...(errors.creditReserveUsdcE6 ? { error: errors.creditReserveUsdcE6 } : {})}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                value={form.reserveText}
                disabled={busy}
                onChange={(e) => set((f) => ({ ...f, reserveText: e.target.value }))}
              />
            )}
          </Field>
        </div>
        <p className="text-xs text-foreground-muted" data-testid="research-settings-cost">
          At most {usdc(facts?.monthlyAtDefaultUsdcE6 ?? "0")} USDC a month at the default budget.
          Saving changes the goal, so the next research run makes a new plan.
        </p>
        <Button
          size="sm"
          className="w-fit"
          onClick={g.save}
          loading={busy}
          disabled={busy || !changed}
        >
          {changed ? "Save" : "No changes"}
        </Button>
        {g.status ? (
          <GoalSaveStatus state={g.status.state} text={g.status.text} reasons={g.status.reasons} />
        ) : null}
      </CardContent>
    </Card>
  );
}
