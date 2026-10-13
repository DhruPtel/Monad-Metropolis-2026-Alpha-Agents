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
  Tag,
  VaultCreateCard,
  VaultDepositForm,
  VaultPanel,
  type VaultPanelView,
  VaultPositionCard,
  VaultWithdrawForm,
  WalletActionStatus,
  type WithdrawMethod,
  whenUtc,
  AccountValueChart,
  BalancesTable,
  PositionsTable,
  StatTileRow,
  TabbedPanel,
  monthReturnBps,
} from "@alpha-agents/ui";
import { ArrowLeft, PlugZap, RotateCcw, Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { Address } from "viem";
import type { VaultJson, VaultResponseJson } from "@/api/client";
import { type VaultAction, type VaultActionStatus, useVault } from "@/agent/use-vault";
import {
  VAULT_DEPOSIT_BLOCK_MESSAGES,
  depositRoom,
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
import { ContributeCreditsSection } from "@/components/credits/contribute-credits-section";

/**
 * The agent's vault (P7-U4): public, with the connected wallet's own position.
 * The vault at a glance, the holder's position with the lockup in plain
 * words, the deposit and withdraw dialogs, the leader's tools, the holdings
 * valued as the vault values them, the performance from the value snapshots,
 * and "Fund this agent" for anyone who is not the owner (D-242).
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

const pct = (bps: number, signed = false) =>
  `${signed && bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;
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
  const [amountText, setAmountText] = useState("");
  const [sharesText, setSharesText] = useState("");
  const [method, setMethod] = useState<WithdrawMethod>("usdc");

  const header = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-foreground-muted">
        <Link href="/agents" className="flex items-center gap-1">
          <ArrowLeft aria-hidden className="size-4" /> My Agents
        </Link>
        <Link href={`/agents/${agentId.toString()}/portfolio`} data-testid="portfolio-link">
          Portfolio
        </Link>
        <Link href={`/agents/${agentId.toString()}/window`}>Performance window</Link>
      </div>
      <h1 className="text-2xl font-semibold">{name}: vault</h1>
      <p className="max-w-2xl text-sm text-foreground-muted">
        A pool on {network} that {name} trades within its hard limits, through the same Executor as
        its own account. Anyone on the beta allowlist may deposit; anyone may leave at any time, in
        USDC or in kind, whatever the agent, the platform or the market is doing.
      </p>
    </div>
  );

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
          tabs={[
            { id: "about", label: "About", content: <VaultPanel v={panel} /> },
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
              label: "Your performance",
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
              {perf.history.points > 0 && perf.history.from ? (
                <>
                  <span className="numeric">{perf.history.points}</span> readings since{" "}
                  <span className="numeric">
                    {whenUtc(Math.floor(Date.parse(perf.history.from) / 1000))}
                  </span>
                  , one every 15 minutes and after every trade.
                </>
              ) : (
                "No readings yet: the first comes within 15 minutes of the vault's first deposit."
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AccountValueChart series={perf.series} principalUsdcE6={null} />
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
              <p className="text-sm">
                Deposits are{" "}
                <Tag tone={s.depositsOpen ? "accent" : "neutral"} size="md">
                  {s.depositsOpen ? "open" : "not open"}
                </Tag>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={vt.busy || s.inHandover || s.windDownAt !== 0}
                  onClick={() => vt.setDepositsOpen(!s.depositsOpen)}
                  data-testid="vault-toggle-deposits"
                >
                  {s.depositsOpen ? "Close deposits" : "Open deposits"}
                </Button>
              </div>
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
                  <Link
                    href={`/agents/${agentId.toString()}/portfolio#trades`}
                    className="underline"
                  >
                    portfolio page
                  </Link>
                  .
                </p>
              ),
            },
            {
              id: "flows",
              label: "Deposits and withdrawals",
              content: (
                <p className="text-sm text-foreground-muted">
                  The list of each deposit and withdrawal, with its date and transaction, comes with
                  the next unit.
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

      {isOwner ? (
        <p className="text-sm text-foreground-muted" data-testid="vault-owner-credits-note">
          Credits for this agent&apos;s work are added from its{" "}
          <Link href={`/agents/${agentId.toString()}/portfolio#credits`} className="underline">
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
