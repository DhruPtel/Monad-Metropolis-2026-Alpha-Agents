"use client";

import { ACCOUNT_MODES, ASSET_IDS, type AccountMode, type AssetId } from "@alpha-agents/domain";
import { LAUNCH_LIMITS } from "@alpha-agents/policy";
import {
  ACCOUNT_MODE_RENDERING,
  AmountDisplay,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  ReasonMessage,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@alpha-agents/ui";
import { CircleCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { DEFAULT_FORM, PRESETS, type SandboxForm, runSandbox } from "@/lib/sandbox";

type TextKey = {
  [K in keyof SandboxForm]: SandboxForm[K] extends string
    ? string extends SandboxForm[K]
      ? K
      : never
    : never;
}[keyof SandboxForm];

export function PolicySandbox() {
  const [form, setForm] = useState<SandboxForm>(DEFAULT_FORM);
  const [presetId, setPresetId] = useState("ok");
  const outcome = useMemo(() => runSandbox(form), [form]);

  const set = (patch: Partial<SandboxForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setPresetId("");
  };
  const text = (key: TextKey, label: string, hint?: string) => (
    <Field label={label} {...(hint ? { hint } : {})}>
      {(control) => (
        <Input
          {...control}
          className="numeric"
          value={form[key]}
          onChange={(e) => set({ [key]: e.target.value })}
        />
      )}
    </Field>
  );
  const assetSelect = (key: "sell" | "buy", label: string) => (
    <Field label={label}>
      {(control) => (
        <Select value={form[key]} onValueChange={(v) => set({ [key]: v as AssetId })}>
          <SelectTrigger {...control}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ASSET_IDS.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Field>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Presets</CardTitle>
          <CardDescription>Each one breaks one launch limit by a small margin.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={p.id === presetId ? "primary" : "secondary"}
                aria-pressed={p.id === presetId}
                onClick={() => {
                  setForm(p.form);
                  setPresetId(p.id);
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Swap intent</CardTitle>
          </CardHeader>
          <CardContent>
            {assetSelect("sell", "Sell")}
            {assetSelect("buy", "Buy")}
            {text("sellAmount", `Sell amount (${form.sell})`)}
            {text("maxSlippageBps", "Max slippage (bps)", `Limit ${LAUNCH_LIMITS.maxSlippageBps}`)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent>
            <Field label="Account mode">
              {(control) => (
                <Select value={form.mode} onValueChange={(v) => set({ mode: v as AccountMode })}>
                  <SelectTrigger {...control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_MODES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {ACCOUNT_MODE_RENDERING[m].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            {text("usdcHolding", "USDC held")}
            {text("wmonHolding", "WMON held")}
            <Field label="WMON on the buy list">
              {(control) => (
                <Select
                  value={form.wmonBuyable ? "yes" : "no"}
                  onValueChange={(v) => set({ wmonBuyable: v === "yes" })}
                >
                  <SelectTrigger {...control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">Yes</SelectItem>
                    <SelectItem value="no">No</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Market and history</CardTitle>
          </CardHeader>
          <CardContent>
            {text("wmonPrice", "WMON price (USDC)")}
            {text(
              "oracleAgeSeconds",
              "MON/USD oracle age (seconds)",
              `Must be under ${LAUNCH_LIMITS.oracleMaxAgeSeconds.MON_USD}`,
            )}
            {text(
              "poolDeviationBps",
              "Pool vs oracle (bps)",
              `Limit ${LAUNCH_LIMITS.oracleMaxDeviationBps} either way`,
            )}
            {text(
              "tradesLast24h",
              "Trades in the last 24 hours",
              `Limit ${LAUNCH_LIMITS.maxTradesPerWindow}`,
            )}
            {text("turnoverUsedUsdc", "Turnover used (USDC)", "Limit 100% of the account's value")}
          </CardContent>
        </Card>
      </div>

      <Card aria-live="polite">
        <CardHeader>
          <CardTitle>Why the agent would or would not trade</CardTitle>
          <CardDescription>
            packages/policy checkSwap with the launch limits. The Executor re-checks everything
            onchain.
          </CardDescription>
        </CardHeader>
        <CardContent data-testid="sandbox-result">
          {outcome.kind === "input" ? (
            <ul className="flex flex-col gap-1 text-sm text-negative">
              {outcome.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : outcome.result.ok ? (
            <div className="flex items-start gap-3 rounded-md border border-positive bg-surface px-4 py-3 text-sm">
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
              <p>
                The trade passes every pre-check: it is worth{" "}
                <AmountDisplay
                  value={outcome.result.value.valueUsdcE6}
                  decimals={6}
                  minFractionDigits={2}
                  symbol="USDC"
                />{" "}
                of an account worth{" "}
                <AmountDisplay
                  value={outcome.result.value.navUsdcE6}
                  decimals={6}
                  minFractionDigits={2}
                  symbol="USDC"
                />
                , with <span className="numeric">{outcome.result.value.tradesLeftAfter}</span>{" "}
                trades left in the window afterwards.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {outcome.result.rejections.map((r) => (
                <ReasonMessage key={`${r.code}-${r.detail}`} code={r.code} detail={r.detail} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
