"use client";

import {
  AmountDisplay,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  toast,
} from "@alpha-agents/ui";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";
import { type BalanceView, giveUsdcAction, readBalancesAction, setMonAction } from "./actions";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const SAMPLE_ADDRESS = "0x00000000000000000000000000000000000beef1";

export function TestFunds() {
  const [address, setAddress] = useState(SAMPLE_ADDRESS);
  const [mon, setMon] = useState("100");
  const [usdc, setUsdc] = useState("2,500");
  const [balances, setBalances] = useState<BalanceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const addressValid = ADDRESS.test(address.trim());

  function run(action: () => Promise<ActionResult<BalanceView>>, success: string) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setBalances(result.value);
      toast.success(success);
    });
  }

  const target = address.trim();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Fund an address</CardTitle>
          <CardDescription>
            Any address works, including contracts and agent accounts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field
            label="Address"
            {...(addressValid ? {} : { error: "0x followed by 40 hex characters" })}
          >
            {(control) => (
              <Input
                {...control}
                className="numeric"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="MON balance" hint="Sets the balance to this amount" className="w-48">
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={mon}
                  onChange={(e) => setMon(e.target.value)}
                />
              )}
            </Field>
            <Button
              variant="secondary"
              disabled={pending || !addressValid}
              onClick={() => run(() => setMonAction(target, mon), "MON balance set")}
            >
              Set MON
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="USDC to add" hint="Minted by the real USDC contract" className="w-48">
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={usdc}
                  onChange={(e) => setUsdc(e.target.value)}
                />
              )}
            </Field>
            <Button
              disabled={pending || !addressValid}
              onClick={() => run(() => giveUsdcAction(target, usdc), "Test USDC minted")}
            >
              Give USDC
            </Button>
          </div>
          {error ? (
            <p
              role="alert"
              data-testid="action-error"
              className="rounded-md border border-negative bg-negative-surface px-4 py-3 text-sm text-negative"
            >
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Balances on the fork</CardTitle>
          <CardDescription>Read back from the chain after every change.</CardDescription>
        </CardHeader>
        <CardContent>
          {balances ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm" data-testid="balances">
              <dt className="text-foreground-muted">MON</dt>
              <dd>
                <AmountDisplay
                  value={BigInt(balances.monWei)}
                  decimals={18}
                  maxFractionDigits={4}
                  symbol="MON"
                />
              </dd>
              <dt className="text-foreground-muted">USDC</dt>
              <dd>
                <AmountDisplay
                  value={BigInt(balances.usdcE6)}
                  decimals={6}
                  minFractionDigits={2}
                  symbol="USDC"
                />
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-foreground-muted">No balances read yet.</p>
          )}
          <div>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending || !addressValid}
              onClick={() => run(() => readBalancesAction(target), "Balances read")}
            >
              Read balances
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
