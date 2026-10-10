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
  createAccountV3Action,
  fundAccountAction,
  fundAccountV3Action,
  readTradesAction,
  registerGrantAction,
  sendTestSwapAction,
  sendTestSwapV3Action,
} from "./actions";
import {
  type RegisteredTokenView,
  type SymbolBook,
  type TradesView,
  type TransactionView,
  amountOf,
  balanceRows,
  describeSwap,
  inFlight,
  isTransactionState,
  isV3Swap,
  knownReason,
  setupSteps,
  setupStepsV3,
  symbolBook,
  tokenOf,
} from "./trades";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
type Custody = "v2" | "v3";

/** One token the owner funds the v3 account with: its address, and the test USDC it gets or buys. */
interface FundingLeg {
  readonly token: string;
  readonly usdc: string;
}

export function TradesPanel({
  usdc,
  wmon,
  limits,
}: {
  usdc: string;
  wmon: string;
  limits: readonly { code: string; text: string }[];
}) {
  const [agentId, setAgentId] = useState("1");
  const [wallet, setWallet] = useState("");
  const [view, setView] = useState<TradesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [custody, setCustody] = useState<Custody>("v2");
  const [custodyChosen, setCustodyChosen] = useState(false);
  const [usdcAmount, setUsdcAmount] = useState("50");
  const [direction, setDirection] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("5");
  const [limit, setLimit] = useState(limits[0]?.code ?? "");
  // F-U5: the v3 set. Three legs: test USDC, and two tokens bought with it (the cap is 100 USDC).
  const [legs, setLegs] = useState<FundingLeg[]>([
    { token: usdc, usdc: "30" },
    { token: wmon, usdc: "20" },
    { token: "", usdc: "20" },
  ]);
  const [sell, setSell] = useState(usdc);
  const [buy, setBuy] = useState(wmon);
  const [amountV3, setAmountV3] = useState("5");
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
    // The agent's own custody set, until the owner picks one by hand.
    if (!custodyChosen && result.value.custody) setCustody(result.value.custody);
  }, [agentId, custodyChosen]);

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

  const v3 = custody === "v3";
  const steps = view ? setupSteps(view) : { account: false, funded: false, grant: false };
  const stepsV3 = view ? setupStepsV3(view) : { account: false, funded: false, grant: false };
  const walletValid = ADDRESS.test(wallet.trim());
  const snap = view?.snapshot ?? null;
  const snapV3 = view?.snapshotV3 ?? null;
  const book: SymbolBook = view ? symbolBook(view, usdc, wmon) : {};
  const tokens: readonly RegisteredTokenView[] = view?.tokens ?? [];
  const ready = Boolean(view?.signerOn && steps.account && steps.grant);
  const readyV3 = Boolean(view?.signerOn && stepsV3.account && stepsV3.grant && view?.executorV3);
  const v3Available = Boolean(snapV3) || Boolean(view?.executorV3);
  const setLeg = (i: number, patch: Partial<FundingLeg>) =>
    setLegs((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Agent</CardTitle>
            <CardDescription>
              Choose an agent on the playtest fork. The wallet is its owner; the buttons act as that
              wallet through anvil impersonation. The custody set is the agent&apos;s own once it
              has an account (D-367); pick the other to try it.
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
              <Field label="Custody set" className="w-60">
                {(control) => (
                  <Select
                    value={custody}
                    onValueChange={(v) => {
                      setCustody(v as Custody);
                      setCustodyChosen(true);
                    }}
                  >
                    <SelectTrigger {...control}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="v2">v2: USDC and WMON</SelectItem>
                      <SelectItem value="v3">v3: fund agent, many tokens</SelectItem>
                    </SelectContent>
                  </Select>
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
              {view?.custody ? (
                <Badge tone="neutral" data-testid="custody-path">
                  On {view.custody}
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
                <dt className="text-foreground-muted">
                  {v3 ? "PersonalAccountV3" : "PersonalAccount"}
                </dt>
                <dd>
                  {v3 ? (
                    snapV3?.account ? (
                      <AddressDisplay address={snapV3.account} label="PersonalAccountV3" />
                    ) : (
                      "none yet"
                    )
                  ) : snap.account ? (
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
                  {(v3 ? snapV3?.grant : snap.grant) ? (
                    <span className="numeric">
                      until{" "}
                      {new Date(Number((v3 ? snapV3?.grant : snap.grant)?.validUntil) * 1000)
                        .toISOString()
                        .slice(0, 16)}{" "}
                      UTC{v3 ? " on Executor v3" : ""}
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
            {v3 && view && snap && !v3Available ? (
              <p className="text-sm text-foreground-muted" data-testid="v3-missing">
                The fund agent&apos;s set is not on this fork; deploy it with pnpm deploy:fund and
                pnpm deploy:executor-v3.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-negative">
                {error}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {v3 ? (
          <Card>
            <CardHeader>
              <CardTitle>Set up the fund account</CardTitle>
              <CardDescription>
                One button per step. Each token is bought with test USDC through its real pools and
                deposited; the deposit cap is {snapV3 ? Number(snapV3.personalCapE6) / 1e6 : 100}{" "}
                USDC of value in all. The grant registers the signer&apos;s session key on Executor
                v3 for 30 days.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={pending || !snap || !walletValid || stepsV3.account || !v3Available}
                  onClick={() =>
                    run(
                      () => createAccountV3Action(agentId, wallet),
                      (a) => `PersonalAccountV3 ${a.slice(0, 10)}... is open`,
                    )
                  }
                >
                  Create fund account
                </Button>
                <Badge tone={stepsV3.account ? "positive" : "neutral"}>
                  {stepsV3.account ? "Open" : "Not yet"}
                </Badge>
              </div>
              <div className="flex flex-col gap-2">
                {legs.map((leg, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <Field label={i === 0 ? "Deposit" : `Buy ${i}`} className="w-44">
                      {(control) =>
                        i === 0 ? (
                          <Input {...control} value="USDC" readOnly />
                        ) : (
                          <Select value={leg.token} onValueChange={(v) => setLeg(i, { token: v })}>
                            <SelectTrigger {...control}>
                              <SelectValue placeholder="Token" />
                            </SelectTrigger>
                            <SelectContent>
                              {tokens
                                .filter((t) => t.token.toLowerCase() !== usdc.toLowerCase())
                                .map((t) => (
                                  <SelectItem key={t.token} value={t.token}>
                                    {t.symbol}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        )
                      }
                    </Field>
                    <Field label="Test USDC" className="w-28">
                      {(control) => (
                        <Input
                          {...control}
                          inputMode="decimal"
                          value={leg.usdc}
                          onChange={(e) => setLeg(i, { usdc: e.target.value })}
                        />
                      )}
                    </Field>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    disabled={pending || !stepsV3.account || !walletValid}
                    onClick={() =>
                      run(
                        () =>
                          fundAccountV3Action(
                            agentId,
                            wallet,
                            legs.filter((l) => l.token !== "" && l.usdc.trim() !== ""),
                          ),
                        (a) => `Deposited ${a}`,
                      )
                    }
                  >
                    Fund with several tokens
                  </Button>
                  <Badge tone={stepsV3.funded ? "positive" : "neutral"}>
                    {stepsV3.funded ? "Funded" : "Empty"}
                  </Badge>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={
                    pending || !snap || !walletValid || !view?.signerOn || !view?.executorV3
                  }
                  onClick={() =>
                    run(
                      () => registerGrantAction(agentId, wallet, view?.executorV3 ?? null),
                      (k) => `Grant registered on Executor v3 for session key ${k.slice(0, 10)}...`,
                    )
                  }
                >
                  Register session grant on Executor v3
                </Button>
                <Badge tone={stepsV3.grant ? "positive" : "neutral"}>
                  {stepsV3.grant ? "Registered" : "None"}
                </Badge>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Set up</CardTitle>
              <CardDescription>
                One button per step. The grant registers the signer&apos;s session key for this
                agent for 30 days; the key itself never leaves the signer.
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
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {v3 ? (
          <Card>
            <CardHeader>
              <CardTitle>Send a test swap</CardTitle>
              <CardDescription>
                Any registered pair, along the best route of up to three registered pools, through
                the signer and Executor v3. The outbox shows every balance change once it is
                reconciled.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Sell" className="w-40">
                  {(control) => (
                    <Select value={sell} onValueChange={setSell}>
                      <SelectTrigger {...control}>
                        <SelectValue placeholder="Token" />
                      </SelectTrigger>
                      <SelectContent>
                        {tokens.map((t) => (
                          <SelectItem key={t.token} value={t.token}>
                            {t.symbol}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
                <Field label="Buy" className="w-40">
                  {(control) => (
                    <Select value={buy} onValueChange={setBuy}>
                      <SelectTrigger {...control}>
                        <SelectValue placeholder="Token" />
                      </SelectTrigger>
                      <SelectContent>
                        {tokens.map((t) => (
                          <SelectItem key={t.token} value={t.token}>
                            {t.symbol}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
                <Field label={`${tokenOf(sell, usdc, book).symbol} in`} className="w-32">
                  {(control) => (
                    <Input
                      {...control}
                      inputMode="decimal"
                      value={amountV3}
                      onChange={(e) => setAmountV3(e.target.value)}
                    />
                  )}
                </Field>
                <Button
                  disabled={pending || !readyV3 || sell.toLowerCase() === buy.toLowerCase()}
                  onClick={() =>
                    run(
                      () => sendTestSwapV3Action(agentId, sell, buy, amountV3),
                      (r) =>
                        `Swap ${r.status} over ${r.hops} hop${r.hops === 1 ? "" : "s"}${
                          r.reasonCode ? `: ${r.reasonCode}` : ""
                        }${r.blockers.length ? ` (the checks say ${r.blockers.join(", ")})` : ""}`,
                    )
                  }
                >
                  Send test swap
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Send a test swap</CardTitle>
              <CardDescription>
                Through the signer and the Executor on the real v4 pool. The ledger gets it only
                after reconciliation.
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
        )}

        <Card>
          <CardHeader>
            <CardTitle>Account balances</CardTitle>
            <CardDescription>
              {v3 ? "Every held token, read from the fork now." : "Read from the fork now."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {v3 ? (
              snapV3?.account ? (
                <div className="flex flex-col gap-2 text-sm" data-testid="holdings-v3">
                  {snapV3.holdings.map((h) => (
                    <div key={h.token} className="flex flex-wrap items-center gap-2">
                      <AmountDisplay
                        value={BigInt(h.balanceRaw)}
                        decimals={h.decimals}
                        symbol={h.symbol}
                        maxFractionDigits={6}
                      />
                      {h.token.toLowerCase() !== usdc.toLowerCase() ? (
                        <span className="text-xs text-foreground-muted">
                          basis {(Number(h.costBasisE6) / 1e6).toFixed(2)} USDC
                        </span>
                      ) : null}
                    </div>
                  ))}
                  <p className="text-xs text-foreground-muted">
                    Value{" "}
                    <span className="numeric">
                      {snapV3.navE6 === null
                        ? "unreadable"
                        : `${(Number(snapV3.navE6) / 1e6).toFixed(2)} USDC`}
                    </span>
                    , {snapV3.holdings.length} of 16 tokens, at block{" "}
                    <span className="numeric">{snapV3.blockNumber}</span>
                  </p>
                </div>
              ) : (
                <p className="text-sm text-foreground-muted">No PersonalAccountV3 yet.</p>
              )
            ) : snap?.account ? (
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
            <Table stack label="The signer's outbox for this agent">
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Request</TableHead>
                  <TableHead>Transaction</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.transactions.map((t) => (
                  <OutboxRow key={t.txId} t={t} usdc={usdc} view={view} book={book} />
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

function OutboxRow({
  t,
  usdc,
  view,
  book,
}: {
  t: TransactionView;
  usdc: string;
  view: TradesView;
  book: SymbolBook;
}) {
  const reason = knownReason(t.reasonCode);
  const entry = t.ledgerEntryId ? view.ledger[t.ledgerEntryId] : undefined;
  const amount = amountOf(t, usdc);
  const rows = balanceRows(t, usdc, book);
  return (
    <TableRow data-status={t.status}>
      <TableCell label="State" className="align-top">
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
      <TableCell label="Request" className="align-top">
        <div className="flex flex-col gap-1">
          <span>{describeSwap(t, usdc, book)}</span>
          {amount ? (
            <AmountDisplay
              value={amount.value}
              decimals={tokenOf(amount.token, usdc, book, isV3Swap(t)).decimals}
              symbol={tokenOf(amount.token, usdc, book, isV3Swap(t)).symbol}
              maxFractionDigits={6}
              className="text-xs text-foreground-muted"
            />
          ) : null}
        </div>
      </TableCell>
      <TableCell label="Transaction" className="numeric align-top text-xs">
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
      <TableCell label="Outcome" className="align-top">
        <div className="flex flex-col gap-2">
          {reason ? (
            <ReasonMessage code={reason} />
          ) : t.reasonCode ? (
            <span className="text-sm">{t.reasonCode}</span>
          ) : null}
          {rows.length > 0 ? (
            <div className="flex flex-col gap-1 text-xs" data-testid="balance-changes">
              <span className="text-foreground-muted">Account balances, before and after:</span>
              {rows.map((b) => (
                <span key={b.token} className="flex flex-wrap items-center gap-1">
                  <AmountDisplay
                    value={b.before}
                    decimals={b.decimals}
                    symbol={b.symbol}
                    maxFractionDigits={6}
                  />
                  <span aria-hidden>to</span>
                  <AmountDisplay
                    value={b.after}
                    decimals={b.decimals}
                    symbol={b.symbol}
                    maxFractionDigits={6}
                  />
                  {b.before === b.after ? (
                    <span className="text-foreground-subtle">(unchanged)</span>
                  ) : null}
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
                  {l.account}{" "}
                  {/^0x/.test(l.asset) ? tokenOf(l.asset, usdc, book, true).symbol : l.asset}{" "}
                  {l.amount}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
