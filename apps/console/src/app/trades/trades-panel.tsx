"use client";

import {
  AddressDisplay,
  AmountDisplay,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  ReasonMessage,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@alpha-agents/ui";
import { ArrowLeftRight } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";
import {
  createAccountAction,
  fundAccountAction,
  readTradesAction,
  registerGrantAction,
  sendTestSwapAction,
} from "./actions";
import {
  type TradesView,
  type TransactionView,
  describeSwap,
  inFlight,
  isTransactionState,
  knownReason,
  setupSteps,
} from "./trades";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const decimalsOf = (token: unknown, usdc: string) =>
  String(token).toLowerCase() === usdc.toLowerCase() ? 6 : 18;
const symbolOf = (token: unknown, usdc: string) =>
  String(token).toLowerCase() === usdc.toLowerCase() ? "USDC" : "WMON";

export function TradesPanel({
  usdc,
  limits,
}: {
  usdc: string;
  limits: readonly { code: string; text: string }[];
}) {
  const [agentId, setAgentId] = useState("1");
  const [wallet, setWallet] = useState("");
  const [view, setView] = useState<TradesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usdcAmount, setUsdcAmount] = useState("50");
  const [direction, setDirection] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("5");
  const [limit, setLimit] = useState(limits[0]?.code ?? "");
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    const result = await readTradesAction(agentId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setView(result.value);
    const owner = result.value.snapshot?.owner;
    if (owner) setWallet((w) => (w === "" ? owner : w));
  }, [agentId]);

  // Live outbox: poll while anything is between accepted and an outcome.
  useEffect(() => {
    if (!view || !inFlight(view.transactions)) return;
    const timer = setTimeout(() => void load(), 1_500);
    return () => clearTimeout(timer);
  }, [view, load]);

  function run<T>(action: () => Promise<ActionResult<T>>, success: (value: T) => string) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error);
      } else {
        setError(null);
        toast.success(success(result.value));
      }
      await load();
    });
  }

  const steps = view ? setupSteps(view) : { account: false, funded: false, grant: false };
  const walletValid = ADDRESS.test(wallet.trim());
  const snap = view?.snapshot ?? null;
  const ready = Boolean(view?.signerOn && steps.account && steps.grant);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Agent</CardTitle>
            <CardDescription>
              Choose an agent on the playtest fork. The wallet is its owner; the buttons act as that
              wallet through anvil impersonation.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Agent ID" className="w-32">
                {(control) => (
                  <Input
                    {...control}
                    className="numeric"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    inputMode="numeric"
                  />
                )}
              </Field>
              <Button variant="secondary" disabled={pending} onClick={() => startTransition(load)}>
                Load
              </Button>
              {view ? (
                <Badge tone={view.signerOn ? "positive" : "negative"}>
                  {view.signerOn ? "Signer running" : "Signer off"}
                </Badge>
              ) : null}
            </div>
            <Field
              label="Owner wallet"
              {...(wallet === "" || walletValid
                ? {}
                : { error: "0x followed by 40 hex characters" })}
            >
              {(control) => (
                <Input
                  {...control}
                  className="numeric"
                  value={wallet}
                  onChange={(e) => setWallet(e.target.value)}
                  placeholder="0x..."
                  spellCheck={false}
                />
              )}
            </Field>
            {snap ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-foreground-muted">Owner</dt>
                <dd>
                  <AddressDisplay address={snap.owner} label="Owner" />
                </dd>
                <dt className="text-foreground-muted">PersonalAccount</dt>
                <dd>
                  {snap.account ? (
                    <AddressDisplay address={snap.account} label="PersonalAccount" />
                  ) : (
                    "none yet"
                  )}
                </dd>
                <dt className="text-foreground-muted">Session key</dt>
                <dd>
                  {view?.sessionKey ? (
                    <AddressDisplay address={view.sessionKey} label="Session key" />
                  ) : (
                    "not created"
                  )}
                </dd>
                <dt className="text-foreground-muted">Grant</dt>
                <dd>
                  {snap.grant ? (
                    <span className="numeric">
                      until{" "}
                      {new Date(Number(snap.grant.validUntil) * 1000).toISOString().slice(0, 16)}{" "}
                      UTC
                    </span>
                  ) : (
                    "none"
                  )}
                </dd>
              </dl>
            ) : view?.forkError ? (
              <p className="text-sm text-negative" data-testid="fork-error">
                The fork could not be read: {view.forkError}
              </p>
            ) : view ? (
              <p className="text-sm text-foreground-muted">Agent {agentId} is not on the fork.</p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-negative">
                {error}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Set up</CardTitle>
            <CardDescription>
              One button per step. The grant registers the signer&apos;s session key for this agent
              for 30 days; the key itself never leaves the signer.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={pending || !snap || !walletValid || steps.account}
                onClick={() =>
                  run(
                    () => createAccountAction(agentId, wallet),
                    (a) => `PersonalAccount ${a.slice(0, 10)}... is open`,
                  )
                }
              >
                Create PersonalAccount
              </Button>
              <Badge tone={steps.account ? "positive" : "neutral"}>
                {steps.account ? "Open" : "Not yet"}
              </Badge>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Test USDC" className="w-32">
                {(control) => (
                  <Input
                    {...control}
                    inputMode="decimal"
                    value={usdcAmount}
                    onChange={(e) => setUsdcAmount(e.target.value)}
                  />
                )}
              </Field>
              <Button
                disabled={pending || !steps.account || !walletValid}
                onClick={() =>
                  run(
                    () => fundAccountAction(agentId, wallet, usdcAmount),
                    (a) => `Deposited ${a} test USDC`,
                  )
                }
              >
                Fund with test USDC
              </Button>
              <Badge tone={steps.funded ? "positive" : "neutral"}>
                {steps.funded ? "Funded" : "Empty"}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={pending || !snap || !walletValid || !view?.signerOn}
                onClick={() =>
                  run(
                    () => registerGrantAction(agentId, wallet),
                    (k) => `Grant registered for session key ${k.slice(0, 10)}...`,
                  )
                }
              >
                Register session grant
              </Button>
              <Badge tone={steps.grant ? "positive" : "neutral"}>
                {steps.grant ? "Registered" : "None"}
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Send a test swap</CardTitle>
            <CardDescription>
              Through the signer and the Executor on the real v4 pool. The ledger gets it only after
              reconciliation.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Direction">
                {(control) => (
                  <Select
                    value={direction}
                    onValueChange={(v) => setDirection(v as "buy" | "sell")}
                  >
                    <SelectTrigger {...control} className="w-52">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="buy">Buy WMON with USDC</SelectItem>
                      <SelectItem value="sell">Sell WMON for USDC</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Field label={direction === "buy" ? "USDC in" : "WMON in"} className="w-32">
                {(control) => (
                  <Input
                    {...control}
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                )}
              </Field>
              <Button
                disabled={pending || !ready}
                onClick={() =>
                  run(
                    () => sendTestSwapAction(agentId, direction, amount, null),
                    (r) => `Swap ${r.status}${r.reasonCode ? `: ${r.reasonCode}` : ""}`,
                  )
                }
              >
                Send test swap
              </Button>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Break a limit" className="min-w-0 flex-1 basis-64">
                {(control) => (
                  <Select value={limit} onValueChange={setLimit}>
                    <SelectTrigger {...control}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {limits.map((l) => (
                        <SelectItem key={l.code} value={l.code}>
                          {l.text}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Button
                variant="secondary"
                disabled={pending || !ready}
                onClick={() =>
                  run(
                    () => sendTestSwapAction(agentId, "buy", "1", limit),
                    (r) => `Refusal recorded: ${r.reasonCode ?? r.status}`,
                  )
                }
              >
                Try the swap that breaks it
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Account balances</CardTitle>
            <CardDescription>Read from the fork now.</CardDescription>
          </CardHeader>
          <CardContent>
            {snap?.account ? (
              <div className="flex flex-col gap-2 text-sm">
                <AmountDisplay value={BigInt(snap.usdcE6)} decimals={6} symbol="USDC" />
                <AmountDisplay
                  value={BigInt(snap.wmonWei)}
                  decimals={18}
                  symbol="WMON"
                  maxFractionDigits={6}
                />
                <p className="text-xs text-foreground-muted">
                  At block <span className="numeric">{snap.blockNumber}</span>
                </p>
              </div>
            ) : (
              <p className="text-sm text-foreground-muted">No PersonalAccount yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Outbox</CardTitle>
          <CardDescription>
            Every transaction the signer was asked for, newest first, live while one is in flight.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {view && view.transactions.length > 0 ? (
            <Table label="The signer's outbox for this agent">
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Swap</TableHead>
                  <TableHead>Transaction</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.transactions.map((t) => (
                  <OutboxRow key={t.txId} t={t} usdc={usdc} view={view} />
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={ArrowLeftRight}
              title="No transactions yet"
              description="Send a test swap and it appears here with every state it passes through."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function OutboxRow({ t, usdc, view }: { t: TransactionView; usdc: string; view: TradesView }) {
  const reason = knownReason(t.reasonCode);
  const entry = t.ledgerEntryId ? view.ledger[t.ledgerEntryId] : undefined;
  const tokenIn = t.intent?.tokenIn;
  const tokenOut = t.intent?.tokenOut;
  return (
    <TableRow data-status={t.status}>
      <TableCell className="align-top">
        <div className="flex flex-col gap-1">
          {isTransactionState(t.status) ? (
            <StatusPill kind="transaction" value={t.status} />
          ) : (
            <Badge>{t.status}</Badge>
          )}
          <span className="text-xs text-foreground-subtle">
            {t.history.map((h) => h.status).join(" > ")}
          </span>
        </div>
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-col gap-1">
          <span>{describeSwap(t, usdc)}</span>
          {t.intent ? (
            <AmountDisplay
              value={BigInt(String(t.intent.amountIn))}
              decimals={decimalsOf(tokenIn, usdc)}
              symbol={symbolOf(tokenIn, usdc)}
              maxFractionDigits={6}
              className="text-xs text-foreground-muted"
            />
          ) : null}
        </div>
      </TableCell>
      <TableCell className="numeric align-top text-xs">
        {t.txHash ? (
          <div className="flex flex-col gap-1">
            <span title={t.txHash}>{t.txHash.slice(0, 14)}...</span>
            {t.nonce !== null ? <span>nonce {t.nonce}</span> : null}
            {t.blockNumber !== null ? <span>block {t.blockNumber}</span> : null}
          </div>
        ) : (
          <span className="text-foreground-subtle">not signed</span>
        )}
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-col gap-2">
          {reason ? (
            <ReasonMessage code={reason} />
          ) : t.reasonCode ? (
            <span className="text-sm">{t.reasonCode}</span>
          ) : null}
          {t.balances && tokenIn && tokenOut ? (
            <div className="flex flex-col gap-1 text-xs">
              <span className="text-foreground-muted">Account balances, before and after:</span>
              {(
                [
                  [tokenIn, t.balances.tokenIn],
                  [tokenOut, t.balances.tokenOut],
                ] as const
              ).map(([token, b]) => (
                <span key={String(token)} className="flex flex-wrap items-center gap-1">
                  <AmountDisplay
                    value={BigInt(b.before)}
                    decimals={decimalsOf(token, usdc)}
                    symbol={symbolOf(token, usdc)}
                    maxFractionDigits={6}
                  />
                  <span aria-hidden>to</span>
                  <AmountDisplay
                    value={BigInt(b.after)}
                    decimals={decimalsOf(token, usdc)}
                    symbol={symbolOf(token, usdc)}
                    maxFractionDigits={6}
                  />
                </span>
              ))}
            </div>
          ) : null}
          {entry ? (
            <div className="flex flex-col gap-1 text-xs" data-testid="ledger-entry">
              <span className="text-foreground-muted">
                Ledger entry <span className="numeric">{entry.entryId.slice(0, 8)}</span> (
                {entry.kind})
              </span>
              {entry.lines.map((l, i) => (
                <span key={i} className="numeric">
                  {l.account} {l.asset} {l.amount}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
