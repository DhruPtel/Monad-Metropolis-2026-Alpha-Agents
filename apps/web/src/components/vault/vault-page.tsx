"use client";

import { type EnvironmentId, ENVIRONMENTS } from "@alpha-agents/config";
import { CHAIN_NAMES, chainOfEnvironment, formatAmount } from "@alpha-agents/domain";
import {
  type AssetRow,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ScoreTile,
  Skeleton,
  VaultCreateCard,
  VaultDepositForm,
  type VaultPanelView,
  VaultPositionCard,
  VaultWithdrawForm,
  WalletActionStatus,
  type WithdrawMethod,
  whenUtc,
  AccountValueChart,
  AddressDisplay,
  InfoList,
  StatusPill,
  lockupWords,
  BalancesTable,
  PositionsTable,
  StatTileRow,
  StepList,
  TabbedPanel,
  monthReturnBps,
  percentFromBps as pct,
} from "@alpha-agents/ui";
import { PlugZap, RotateCcw, Wallet } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { type VaultJson, type VaultResponseJson, api } from "@/api/client";
import { type VaultAction, type VaultActionStatus, useVault } from "@/agent/use-vault";
import {
  VAULT_DEPOSIT_BLOCK_MESSAGES,
  depositRoom,
  leaderSetup,
  lockUntil,
  previewInKind,
  previewShares,
  previewUsdc,
  topUpWarning,
  usdcAvailable,
  vaultDepositBlock,
  vaultWithdrawBlock,
} from "@/agent/vault-v3";
import { walletTxText } from "@/agent/wallet-tx";
import { useWalletSession } from "@/auth/session";
import { AgentActivity } from "@/components/activity/agent-activity";
import { ContributeCreditsSection } from "@/components/credits/contribute-credits-section";

/**
 * The agent's vault (P7-U4): public, with the connected wallet's own position.
 * The vault at a glance, the holder's position with the lockup in plain
 * words, the deposit and withdraw dialogs, the leader's tools, the holdings
 * valued as the vault values them, the performance from the value snapshots,
 * and "Add research credits" for anyone who is not the owner (D-242).
 */
const BPS = 10_000n;

const usdc2 = (e6: bigint | string) =>
  (Number(e6) / 1e6).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function StatusFor({
  status,
  actions,
}: {
  status: VaultActionStatus | null;
  actions: readonly VaultAction[];
}) {
  if (!status || !actions.includes(status.action)) return null;
  const p = status.progress;
  const text = p.state === "confirmed" ? status.done || "Done." : walletTxText(p);
  return <WalletActionStatus state={p.state} text={text} hash={p.hash ?? null} />;
}

/** Every held token as the makeup table and the donut show it. */
function vaultRows(v: VaultJson): AssetRow[] {
  const held = (v.state?.holdings ?? []).filter((h) => BigInt(h.amountRaw) > 0n);
  const total = held.reduce(
    (t, h) => t + (h.valueUsdcE6 === null ? 0n : BigInt(h.valueUsdcE6)),
    0n,
  );
  return held
    .map((h) => {
      const cash = h.token.toLowerCase() === v.contracts.usdc.toLowerCase();
      const value = h.valueUsdcE6 === null ? null : BigInt(h.valueUsdcE6);
      const basis = cash ? value : BigInt(h.costBasisUsdcE6);
      const gain = !cash && value !== null ? value - BigInt(h.costBasisUsdcE6) : null;
      return {
        symbol: h.symbol,
        decimals: h.decimals,
        amountRaw: h.amountRaw,
        isCash: cash,
        valueUsdcE6: h.valueUsdcE6,
        shareBps: value === null || total === 0n ? null : Number((value * BPS) / total),
        costBasisUsdcE6: basis === null ? null : basis.toString(),
        gainUsdcE6: gain === null ? null : gain.toString(),
        gainBps:
          gain === null || basis === null || basis === 0n ? null : Number((gain * BPS) / basis),
      };
    })
    .sort((a, b) => Number(BigInt(b.valueUsdcE6 ?? "-1") - BigInt(a.valueUsdcE6 ?? "-1")));
}

function panelView(v: VaultJson): VaultPanelView | null {
  if (!v.vault || !v.state) return null;
  const s = v.state;
  return {
    vault: v.vault,
    mode: s.mode,
    inHandover: s.inHandover,
    windDownAt: s.windDownAt,
    depositsOpen: s.depositsOpen,
    depositsClosed: s.depositsClosed,
    navUsdcE6: s.navUsdcE6,
    totalSupply: s.totalSupply,
    perUnitE18: s.perUnitE18,
    lockupSeconds: s.lockupSeconds,
    leaderStakeBps: s.leaderStakeBps,
    leaderMinBps: s.constants.leaderMinBps,
    feeBps: s.feeBps,
    principalUsdcE6: s.principalUsdcE6,
    vaultCapUsdcE6: v.factory.vaultCapUsdcE6,
    allowlistEnabled: v.factory.allowlistEnabled,
    depositsEnabled: v.factory.depositsEnabled,
    handoverPeriodSeconds: s.constants.handoverPeriodSeconds,
    asOf: v.timestamp,
  };
}

const usdc = (e6: string | bigint) => formatAmount(BigInt(e6), 6, { maxFractionDigits: 6 });
const shares = (e18: bigint) => formatAmount(e18, 18, { maxFractionDigits: 18 }).replace(/,/g, "");

export function VaultPage({
  environment,
  agentId,
}: {
  environment: EnvironmentId;
  agentId: bigint;
}) {
  const wallet = useWalletSession();
  const vt = useVault(agentId, environment);
  const name = `Agent #${agentId.toString()}`;
  const network = ENVIRONMENTS[environment].label;
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  // 2026-10-13: when the vault was created, for About.
  const [created, setCreated] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    void api.moneyEvents(agentId).then(
      (r) => on && setCreated(r.created.vault),
      () => undefined,
    );
    return () => {
      on = false;
    };
  }, [agentId]);
  const [amountText, setAmountText] = useState("");
  const [sharesText, setSharesText] = useState("");
  const [method, setMethod] = useState<WithdrawMethod>("usdc");

  // UI-FAST: the agent's header and tabs come from its shell.
  const header = null;

  const d: VaultResponseJson | null = vt.data;
  if (!d)
    return (
      <div className="flex flex-col gap-6">
        {header}
        {vt.error ? (
          <EmptyState
            icon={PlugZap}
            title="Could not read this vault"
            description={vt.error}
            action={
              <Button variant="secondary" onClick={vt.refresh}>
                <RotateCcw aria-hidden /> Try again
              </Button>
            }
          />
        ) : (
          <div aria-busy="true" aria-label="Loading the vault" className="flex flex-col gap-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}
      </div>
    );

  const v = d.vault;
  // The lock is against the chain's clock, which the reading carries; the page re-reads every few seconds.
  const now = v.timestamp;
  const viewer = v.viewer;
  const isOwner = viewer?.isOwner ?? false;
  const connected = wallet.ready && !!wallet.address;
  const wrongChain = wallet.state === "wrong-chain";
  const walletPrompt = !connected ? (
    <EmptyState
      icon={Wallet}
      title="Connect your wallet"
      description={
        wrongChain
          ? `Your wallet is on another network. Switch it to ${network} to deposit or withdraw.`
          : "Connect to see your own position and to deposit or withdraw."
      }
      action={
        wrongChain ? (
          <Button onClick={wallet.switchChain}>Switch network</Button>
        ) : (
          <Button onClick={wallet.connect}>
            <Wallet aria-hidden /> Connect wallet
          </Button>
        )
      }
    />
  ) : null;
  const fund =
    d.funding && connected && !isOwner ? (
      <Card id="fund" data-testid="vault-fund">
        <CardContent>
          <ContributeCreditsSection
            agentId={agentId}
            agentName={name}
            environment={environment}
            fundingAddress={d.funding.fundingAddress as Address}
            creditsUsdcE6={BigInt(d.funding.creditsUsdcE6)}
            capUsdcE6={BigInt(d.funding.creditCapUsdcE6)}
            onCredited={vt.refresh}
          />
        </CardContent>
      </Card>
    ) : null;

  const panel = panelView(v);
  if (!panel || !v.state) {
    return (
      <div className="flex flex-col gap-6" data-testid="vault-page" data-state="none">
        {header}
        <Card>
          <CardContent>
            <VaultCreateCard
              agentName={name}
              predictedVault={v.predictedVault}
              isOwner={isOwner}
              lockupSeconds={86_400}
              leaderMinBps={500}
              vaultCapUsdcE6={v.factory.vaultCapUsdcE6}
              onCreate={vt.createVault}
              disabled={vt.busy || !connected}
              status={<StatusFor status={vt.status} actions={["create"]} />}
            />
          </CardContent>
        </Card>
        {walletPrompt}
        {fund}
      </div>
    );
  }

  const s = v.state;
  const block = vaultDepositBlock(v);
  const setup = leaderSetup(v);
  const blockText = block ? VAULT_DEPOSIT_BLOCK_MESSAGES[block] : null;
  const room = depositRoom(v);
  const amount = parseUsdcText(amountText);
  const preview = amount === null ? null : previewShares(v, amount);
  const sharesWanted = parseSharesText(sharesText);
  const withdrawBlock = vaultWithdrawBlock(v, now);
  const rows = vaultRows(v);
  const perf = d.performance;
  // UX-U1: the top tiles' figures.
  const monthBps = monthReturnBps(perf.series);
  const earnedE6 = rows.reduce<bigint | null>(
    (acc, r) => (r.gainUsdcE6 === null ? acc : (acc ?? 0n) + BigInt(r.gainUsdcE6)),
    null,
  );
  const ret = perf.scores.returnSinceStart;
  const dd = perf.scores.maxDrawdown;
  const valued = perf.series.filter((p) => p.valueUsdcE6 !== null);
  // 2026-10-13: About as a plain list, with the next step as its one main action.
  const setupNow = leaderSetup(v);
  const hasShares = viewer !== null && viewer !== undefined && BigInt(viewer.shares) > 0n;
  const primary =
    isOwner && viewer ? (
      !setupNow.staked ? (
        <Button size="sm" onClick={() => setDepositOpen(true)} disabled={vt.busy}>
          Stake
        </Button>
      ) : !s.depositsOpen && setupNow.openBlock === null ? (
        <Button size="sm" onClick={() => vt.setDepositsOpen(true)} disabled={vt.busy}>
          Open deposits
        </Button>
      ) : null
    ) : viewer && s.depositsOpen ? (
      <Button size="sm" onClick={() => setDepositOpen(true)} disabled={vt.busy}>
        Deposit
      </Button>
    ) : null;
  const about = (
    <InfoList
      testId="vault-about-list"
      rows={[
        {
          label: "Leader",
          value: (
            <span className="inline-flex items-center gap-2">
              <AddressDisplay address={s.leader} label="Leader" />
              {isOwner ? <span className="text-xs">(you)</span> : null}
            </span>
          ),
        },
        {
          label: "Status",
          value: s.inHandover ? (
            "In a handover"
          ) : s.windDownAt !== 0 ? (
            "Winding down"
          ) : s.mode ? (
            <StatusPill kind="account_mode" value={s.mode} />
          ) : (
            "Unknown"
          ),
        },
        { label: "Lockup", value: lockupWords(s.lockupSeconds) },
        {
          label: "Fees",
          value: s.feeBps === 0 ? "No exit fee" : `${pct(s.feeBps)} of gains, on exit`,
        },
        {
          label: "Leader stake",
          value: `${pct(s.leaderStakeBps)} (at least ${pct(s.constants.leaderMinBps)})`,
        },
        { label: "Deposits", value: s.depositsOpen ? "Open" : "Closed" },
        {
          label: "Created",
          value: created ? whenUtc(Math.floor(Date.parse(created) / 1000)) : "–",
        },
      ]}
      primary={primary}
      secondary={
        hasShares ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setWithdrawOpen(true)}
            disabled={vt.busy}
          >
            Withdraw
          </Button>
        ) : null
      }
    />
  );

  return (
    <div className="flex flex-col gap-6" data-testid="vault-page" data-state="vault">
      {header}
      {/* UX-U1: the vault laid out as a vault page: the top tiles, the left panel of tabs, the chart, the ledger. */}
      <StatTileRow
        tiles={[
          {
            label: "Vault value",
            value: s.navUsdcE6 === null ? null : `${usdc2(s.navUsdcE6)} USDC`,
            note: "Every holding at the vault's own prices",
            testId: "vault-tile-value",
          },
          {
            label: "Past month",
            value: monthBps === null ? null : pct(monthBps, true),
            tone:
              monthBps === null
                ? "neutral"
                : monthBps > 0
                  ? "positive"
                  : monthBps < 0
                    ? "negative"
                    : "neutral",
            note:
              monthBps === null
                ? "Needs two readings over the last 30 days"
                : "On the value of one share",
            testId: "vault-tile-month",
          },
          {
            label: "Your value",
            value: viewer?.valueUsdcE6 ? `${usdc2(viewer.valueUsdcE6)} USDC` : null,
            note: viewer ? "Your shares at the vault's prices" : "Connect your wallet",
            testId: "vault-tile-yours",
          },
          {
            label: "All-time earned",
            value:
              earnedE6 === null
                ? null
                : `${earnedE6 >= 0n ? "+" : "-"}${usdc2(earnedE6 < 0n ? -earnedE6 : earnedE6)} USDC`,
            tone:
              earnedE6 === null
                ? "neutral"
                : earnedE6 > 0n
                  ? "positive"
                  : earnedE6 < 0n
                    ? "negative"
                    : "neutral",
            note: "The vault's holdings over what they cost",
            testId: "vault-tile-earned",
          },
        ]}
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <TabbedPanel
          testId="vault-about"
          defaultTab="yours"
          tabs={[
            { id: "about", label: "About", content: about },
            {
              id: "agent",
              label: "Agent performance",
              content: (
                <div className="grid max-w-2xl grid-cols-2 gap-3">
                  <ScoreTile
                    label="Return since the start"
                    value={ret.ok ? pct(ret.bps, true) : null}
                    tone={
                      ret.ok
                        ? ret.bps > 0
                          ? "positive"
                          : ret.bps < 0
                            ? "negative"
                            : "neutral"
                        : "neutral"
                    }
                    note={
                      ret.ok
                        ? `From the first reading on ${whenUtc(Math.floor(Date.parse(ret.since) / 1000))}`
                        : ret.reason
                    }
                    testId="vault-score-return"
                  />
                  <ScoreTile
                    label="Largest fall from a peak"
                    value={dd.ok ? pct(-dd.bps) : null}
                    tone={dd.ok ? (dd.bps > 0 ? "negative" : "neutral") : "neutral"}
                    note={
                      dd.ok
                        ? `Peak ${whenUtc(Math.floor(Date.parse(dd.peakAt) / 1000))}, low ${whenUtc(Math.floor(Date.parse(dd.troughAt) / 1000))}`
                        : dd.reason
                    }
                    testId="vault-score-drawdown"
                  />
                </div>
              ),
            },
            {
              id: "yours",
              label: "Deposit",
              content: (
                <>
                  {connected && viewer ? (
                    <VaultPositionCard
                      shares={viewer.shares}
                      valueUsdcE6={viewer.valueUsdcE6}
                      unlockAt={viewer.unlockAt}
                      now={now}
                      inKind={viewer.inKind}
                      claimables={viewer.claimables}
                      isLeader={viewer.isLeader}
                      busy={vt.busy}
                      onClaim={(token) => {
                        const c = viewer.claimables.find((x) => x.token === token);
                        vt.claim(token as Address, c?.symbol ?? "token");
                      }}
                      actions={
                        <>
                          <Button
                            size="sm"
                            onClick={() => setDepositOpen(true)}
                            disabled={vt.busy}
                            data-testid="vault-open-deposit"
                          >
                            {viewer.isOwner
                              ? BigInt(viewer.shares) === 0n
                                ? "Stake"
                                : "Stake more"
                              : "Deposit"}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setWithdrawOpen(true)}
                            disabled={vt.busy || BigInt(viewer.shares) === 0n}
                            data-testid="vault-open-withdraw"
                          >
                            Withdraw
                          </Button>
                        </>
                      }
                      status={<StatusFor status={vt.status} actions={["claim", "create"]} />}
                    />
                  ) : (
                    walletPrompt
                  )}
                </>
              ),
            },
          ]}
        />
        <Card id="performance" data-testid="vault-performance">
          <CardHeader>
            <CardTitle>Value of the vault</CardTitle>
            <CardDescription>
              {valued.length > 0 && valued[0] ? (
                <>
                  <span className="numeric">{valued.length}</span>{" "}
                  {valued.length === 1 ? "reading" : "readings"} with a value since{" "}
                  <span className="numeric">
                    {whenUtc(Math.floor(Date.parse(valued[0].at) / 1000))}
                  </span>
                  , one every 15 minutes and after every trade.
                </>
              ) : (
                "No readings yet: the first comes within 15 minutes of the vault's first deposit."
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AccountValueChart
              series={perf.series}
              principalUsdcE6={null}
              fewText="More history builds as the vault runs."
            />
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {isOwner && viewer ? (
          <Card data-testid="vault-leader-tools">
            <CardHeader>
              <CardTitle>Leader tools</CardTitle>
              <CardDescription>
                You manage this vault as the agent&apos;s owner. Your deposits are the stake, which
                must stay at least {pct(s.constants.leaderMinBps)} of the vault for others to
                deposit. Deposits need at least 1 USDC of stake before they can open.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <StepList
                label="Vault setup"
                steps={[
                  {
                    key: "stake",
                    label: "Stake at least 1 USDC",
                    state: setup.staked ? "done" : "current",
                    detail: setup.staked
                      ? `Your stake is ${pct(s.leaderStakeBps)} of the vault.`
                      : `Your deposits are the stake: at least 1 USDC, and at least ${pct(s.constants.leaderMinBps)} of the vault.`,
                    action: (
                      <Button
                        size="sm"
                        onClick={() => setDepositOpen(true)}
                        disabled={vt.busy}
                        data-testid="vault-leader-stake"
                      >
                        Stake
                      </Button>
                    ),
                  },
                  {
                    key: "open",
                    label: "Open deposits",
                    state: s.depositsOpen ? "done" : setup.openBlock ? "blocked" : "current",
                    detail: s.depositsOpen
                      ? "Deposits are open: others can deposit."
                      : (setup.openBlock ?? "Others can deposit once deposits are open."),
                    action: (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={vt.busy}
                        onClick={() => vt.setDepositsOpen(true)}
                        data-testid="vault-toggle-deposits"
                      >
                        Open deposits
                      </Button>
                    ),
                  },
                ]}
              />
              {s.depositsOpen ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={vt.busy}
                    onClick={() => vt.setDepositsOpen(false)}
                    data-testid="vault-toggle-deposits"
                  >
                    Close deposits
                  </Button>
                </div>
              ) : null}
              <StatusFor status={vt.status} actions={["deposits-open"]} />
            </CardContent>
          </Card>
        ) : (
          fund
        )}
      </div>
      <div id="holdings">
        <TabbedPanel
          testId="vault-ledger"
          defaultTab="positions"
          tabs={[
            {
              id: "balances",
              label: "Balances",
              content: (
                <BalancesTable rows={rows} chain={CHAIN_NAMES[chainOfEnvironment(environment)]} />
              ),
            },
            {
              id: "positions",
              label: "Positions",
              content: (
                <PositionsTable rows={rows} chain={CHAIN_NAMES[chainOfEnvironment(environment)]} />
              ),
            },
            {
              id: "trades",
              label: "Trade history",
              content: (
                <p className="text-sm text-foreground-muted">
                  The agent&apos;s trades, this vault&apos;s among them, are listed on its{" "}
                  <Link href={`/agents/${agentId.toString()}/trading`} className="underline">
                    portfolio page
                  </Link>
                  .
                </p>
              ),
            },
            {
              id: "depositors",
              label: "Depositors",
              content: (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-foreground-muted">Shares in all</dt>
                  <dd className="numeric">
                    {formatAmount(BigInt(s.totalSupply), 18, { maxFractionDigits: 4 })}
                  </dd>
                  <dt className="text-foreground-muted">The leader&apos;s</dt>
                  <dd className="numeric">{pct(s.leaderStakeBps)}</dd>
                  <dt className="text-foreground-muted">Yours</dt>
                  <dd className="numeric">
                    {viewer && BigInt(s.totalSupply) > 0n
                      ? pct(Number((BigInt(viewer.shares) * 10_000n) / BigInt(s.totalSupply)))
                      : "–"}
                  </dd>
                  <dt className="text-foreground-muted">Every depositor</dt>
                  <dd className="text-foreground-muted">The list comes with the next unit.</dd>
                </dl>
              ),
            },
          ]}
        />
      </div>

      <AgentActivity agentId={agentId} environment={environment} />

      {isOwner ? (
        <p className="text-sm text-foreground-muted" data-testid="vault-owner-credits-note">
          Credits for this agent&apos;s work are added from its{" "}
          <Link href={`/agents/${agentId.toString()}`} className="underline">
            portfolio
          </Link>
          ; other people fund it here.
        </p>
      ) : null}

      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent aria-describedby="vault-deposit-description">
          <DialogHeader>
            <DialogTitle>
              {viewer?.isOwner ? "Stake in the vault" : "Deposit into the vault"}
            </DialogTitle>
            <DialogDescription id="vault-deposit-description">
              USDC from your wallet, in two wallet transactions: an exact approval, then the
              deposit.
            </DialogDescription>
          </DialogHeader>
          {viewer ? (
            <VaultDepositForm
              amountText={amountText}
              onAmountChange={setAmountText}
              onDeposit={(a) => vt.deposit(a, usdc(a))}
              walletUsdcE6={viewer.usdcWalletE6}
              maxUsdcE6={room.toString()}
              lockupSeconds={s.lockupSeconds}
              isLeader={viewer.isOwner}
              spreadBps={s.constants.spreadBps}
              block={blockText}
              topUpWarning={topUpWarning(v, now)}
              previewShares={preview === null ? null : preview.toString()}
              lockUntil={lockUntil(v, now)}
              disabled={vt.busy}
              status={<StatusFor status={vt.status} actions={["deposit"]} />}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent aria-describedby="vault-withdraw-description">
          <DialogHeader>
            <DialogTitle>Withdraw from the vault</DialogTitle>
            <DialogDescription id="vault-withdraw-description">
              Redeem shares for USDC or for your share of every token the vault holds. One wallet
              transaction, paid to your own wallet.
            </DialogDescription>
          </DialogHeader>
          {viewer ? (
            <VaultWithdrawForm
              method={method}
              onMethodChange={setMethod}
              sharesText={sharesText}
              onSharesChange={setSharesText}
              freeShares={viewer.freeShares}
              heldShares={viewer.shares}
              previewUsdcE6={
                sharesWanted === null ? null : (previewUsdc(v, sharesWanted)?.toString() ?? null)
              }
              previewInKind={sharesWanted === null ? null : previewInKind(v, sharesWanted)}
              usdcAvailableE6={usdcAvailable(v)?.toString() ?? null}
              block={withdrawBlock}
              spreadBps={s.constants.spreadBps}
              onWithdraw={(sh, m) => vt.withdraw(sh, m, shares(sh))}
              disabled={vt.busy}
              status={<StatusFor status={vt.status} actions={["withdraw"]} />}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Whole or decimal USDC with at most 6 decimals, or null. */
function parseUsdcText(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0") || "0");
}

/** Whole or decimal shares with at most 18 decimals, or null. */
function parseSharesText(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0") || "0");
}
