"use client";

import {
  ACCOUNT_MODES,
  AGENT_STATES,
  DISPLAY_FLAGS,
  REJECTION_CODES,
  SIGNER_REASON_CODES,
  TRANSACTION_STATES,
  INTENT_STATES,
  ARMING_STATES,
  TRADE_FLOW_CODES,
  RESEARCH_INTENSITIES,
  RESEARCH_INTENSITY_FACTS,
  AGGRESSIVENESS_FACTS,
  AGGRESSIVENESS_LEVELS,
  type ResearchIntensity,
  type Aggressiveness,
  MODEL_TIERS,
  MODEL_TIER_FACTS,
} from "@alpha-agents/domain";
import { Bot, Boxes, Copy, Eye, Radio, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  ChoiceGroup,
  SourcedFigure,
  CodeBlock,
  CostPreview,
  EffectiveLimits,
  GoalSaveStatus,
  GoalSummary,
  LimitField,
  AddressDisplay,
  AgentCard,
  AmountDisplay,
  MINT_PANEL_STATES,
  MINT_STATES,
  MintButton,
  PendingAgentNotice,
  HoldingsPanel,
  MintPanel,
  SLOT_STATES,
  SlotHex,
  SpeciesArt,
  TierCard,
  ViewerFrame,
  BetaBanner,
  DemandCounter,
  ReasonMessage,
  RISK_LEVELS,
  RiskBadge,
  RUNTIME_STATUSES,
  RuntimeStatusBadge,
  TaskResult,
  ActivityFeed,
  AgentTerminal,
  BudgetMeter,
  MarketSnapshotPanel,
  PlanUnchangedCard,
  ResearchOverview,
  ResearchScheduleCard,
  SentinelCard,
  StageTimeline,
  TERMINAL_STATES,
  type TerminalLineView,
  ThemesPanel,
  TriggerList,
  TOOL_CALL_STATUSES,
  ToolCallStatusBadge,
  AddCreditsPanel,
  AllocationBar,
  AllocationChart,
  AllocationDonut,
  AssetMakeupTable,
  type AssetRow,
  FundOverview,
  OlderAccountCard,
  HundredDollarTile,
  PerformanceChart,
  ScoreTiles,
  type SeriesPoint,
  type TradeMarkView,
  ApprovalCard,
  ArmingCard,
  GasNotice,
  PortfolioOverview,
  CapsPanel,
  FundAgentPanel,
  PositionsPanel,
  type PositionsView,
  RecentTrades,
  WalletActionStatus,
  WhyNotTraded,
  QrCode,
  RUN_STATUSES,
  RunStatusBadge,
  SpendPanel,
  StatBar,
  StatusPill,
  WALLET_STATES,
  WalletButton,
  WalletNotice,
  WrongChainPrompt,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Field,
  Input,
  SectionLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectMenuPreview,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Slider,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tag,
  ToastSurface,
  toast,
  Tooltip,
  TooltipContent,
  TooltipSurface,
  TooltipTrigger,
  cn,
  COLOR_TOKENS,
  MOTION_TOKENS,
  RADIUS_SCALE,
  SHADOW_SCALE,
  SPACING_SCALE,
  TYPE_SCALE,
  NoChangeNotice,
  PlanCard,
  ACTIVATION_STATUSES,
  ActivationChecks,
  ActivationPanel,
  type ActivationPanelView,
  ActivationStatusTag,
} from "@alpha-agents/ui";

// Sample data from the design brief (Planv1/design-brief.md).
const AGENT_WALLET = "0x2FE5ccb0d7Ea195FEb87987d3573F9fcCE2b5D57";
const LEADERBOARD = [
  {
    rank: 1,
    agent: "UNIT-07",
    returnBps: 310,
    drawdownBps: 420,
    tvlE6: 12_480_000_000n,
    watchers: 41,
  },
  {
    rank: 2,
    agent: "HALCYON-3",
    returnBps: 240,
    drawdownBps: 310,
    tvlE6: 8_920_500_000n,
    watchers: 27,
  },
  {
    rank: 3,
    agent: "MOTH-12",
    returnBps: -120,
    drawdownBps: 680,
    tvlE6: 3_105_250_000n,
    watchers: 12,
  },
] as const;
const SKILLS = [
  "Market Scanner",
  "Fast Execution",
  "Yield Discovery",
  "Risk Shield",
  "Deep Research",
];
const pct = (bps: number) => `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(1)}%`;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-6 border-t pt-8">
      <h2 id={`${id}-title`} className="text-2xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Specimen({ name, note, children }: { name: string; note?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-lg font-semibold">{name}</h3>
        {note ? <p className="text-sm text-foreground-muted">{note}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** One labelled state of a component. */
function State({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <span className="text-xs text-foreground-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

const STATE_GRID = "grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5";

function TokensSection() {
  return (
    <Section id="tokens" title="Tokens">
      <Specimen
        name="Color"
        note="Semantic tokens. Lime only for primary actions, active states and positive values; red only for losses and errors."
      >
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {COLOR_TOKENS.map((token) => (
            <li
              key={token.name}
              className="flex items-center gap-3 rounded-lg border bg-surface p-3"
            >
              <span
                aria-hidden
                className="size-10 shrink-0 rounded-md border border-border-strong"
                style={{ backgroundColor: `var(--${token.name})` }}
              />
              <span className="flex min-w-0 flex-col">
                <span className="numeric text-sm text-foreground">--{token.name}</span>
                <span className="text-xs text-foreground-muted">{token.use}</span>
              </span>
            </li>
          ))}
        </ul>
      </Specimen>
      <Specimen
        name="Type scale"
        note="Inter for interface text, JetBrains Mono for every number, amount and address. Body text is 13px with tabular figures."
      >
        <div className="flex flex-col gap-3">
          {TYPE_SCALE.map((step) => (
            <div key={step.name} className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <span className="numeric w-12 text-xs text-foreground-muted">{step.name}</span>
              <span className={step.className}>{step.sample}</span>
              <span className={cn("numeric text-foreground-muted", step.className)}>12,480.00</span>
            </div>
          ))}
        </div>
      </Specimen>
      <Specimen name="Spacing" note="Every gap and padding is a step of the 0.25rem unit.">
        <div className="flex flex-col gap-2">
          {SPACING_SCALE.map((step) => (
            <div key={step.step} className="flex items-center gap-3">
              <span className="numeric w-12 text-xs text-foreground-muted">{step.step}</span>
              <span aria-hidden className={cn("h-3 rounded-sm bg-detail", step.className)} />
            </div>
          ))}
        </div>
      </Specimen>
      <div className="grid gap-8 sm:grid-cols-2">
        <Specimen name="Radius">
          <div className="flex flex-wrap gap-3">
            {RADIUS_SCALE.map((r) => (
              <div key={r.name} className="flex flex-col items-center gap-1">
                <span
                  aria-hidden
                  className={cn(
                    "size-12 border border-border-strong bg-surface-raised",
                    r.className,
                  )}
                />
                <span className="numeric text-xs text-foreground-muted">{r.name}</span>
              </div>
            ))}
          </div>
        </Specimen>
        <Specimen name="Shadow and border" note="Cards are flat: raised is none, only a border.">
          <div className="flex flex-wrap gap-4">
            {SHADOW_SCALE.map((s) => (
              <div key={s.name} className="flex flex-col items-center gap-1">
                <span
                  aria-hidden
                  className={cn("size-12 rounded-md border bg-surface-raised", s.className)}
                />
                <span className="numeric text-xs text-foreground-muted">{s.name}</span>
              </div>
            ))}
          </div>
        </Specimen>
      </div>
      <Specimen
        name="Motion"
        note="Transitions use the fast duration and snap easing; every animation stops when the viewer prefers reduced motion."
      >
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-1">
            {MOTION_TOKENS.map((token) => (
              <li key={token.name} className="flex flex-wrap items-baseline gap-x-3">
                <span className="numeric text-sm text-foreground">--{token.name}</span>
                <span className="text-xs text-foreground-muted">{token.use}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-6">
            <State label="slot-pulse (empty slot)">
              <span
                aria-hidden
                className="size-4 animate-slot-pulse rounded-xs border border-primary-muted"
              />
            </State>
            <State label="status-pulse (live status dot)">
              <span aria-hidden className="size-2 animate-status-pulse rounded-full bg-primary" />
            </State>
          </div>
        </div>
      </Specimen>
    </Section>
  );
}

function ActionsSection() {
  const variants = ["primary", "secondary", "secondary-accent", "ghost", "danger"] as const;
  const labels = {
    primary: "Deploy build",
    secondary: "Run check",
    "secondary-accent": "Run agent test",
    ghost: "View profile",
    danger: "Pause agent",
  };
  return (
    <Section id="actions" title="Buttons">
      {variants.map((variant) => (
        <Specimen key={variant} name={`Button, ${variant}`}>
          <div className={STATE_GRID}>
            <State label="Default">
              <Button variant={variant}>{labels[variant]}</Button>
            </State>
            <State label="Hover">
              <Button variant={variant} data-force="hover">
                {labels[variant]}
              </Button>
            </State>
            <State label="Focus">
              <Button variant={variant} data-force="focus">
                {labels[variant]}
              </Button>
            </State>
            <State label="Disabled">
              <Button variant={variant} disabled>
                {labels[variant]}
              </Button>
            </State>
            <State label="Loading">
              <Button variant={variant} loading>
                {labels[variant]}
              </Button>
            </State>
          </div>
        </Specimen>
      ))}
      <Specimen name="Button sizes" note="28, 36 and 40px tall; icon buttons match medium.">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">Small, 28px</Button>
          <Button size="md">Medium, 36px</Button>
          <Button size="lg">Large, 40px</Button>
          <Button size="icon" variant="secondary" aria-label="Copy">
            <Copy aria-hidden />
          </Button>
        </div>
      </Specimen>
    </Section>
  );
}

function LabelsSection() {
  const tones = [
    { tone: "neutral", label: "Common" },
    { tone: "rare", label: "Rare" },
    { tone: "legendary", label: "Legendary" },
    { tone: "accent", label: "Equipped" },
    { tone: "warning", label: "Expiring" },
  ] as const;
  return (
    <Section id="labels" title="Tags and labels">
      <Specimen
        name="Tag"
        note="Rarity and category. Square 3px corners, 18px (small) or 22px (medium) tall; no status meaning."
      >
        <div className={STATE_GRID}>
          {tones.map(({ tone, label }) => (
            <State key={tone} label={tone}>
              <Tag tone={tone}>{label}</Tag>
              <Tag tone={tone} size="md">
                {label}
              </Tag>
            </State>
          ))}
        </div>
      </Specimen>
      <Specimen
        name="Section label"
        note="Mono, uppercase, label tracking; a real heading at the level the page needs."
      >
        <div className="flex max-w-dialog flex-col gap-2 rounded-lg border bg-surface p-4">
          <SectionLabel as="h4">What this agent does</SectionLabel>
          <p className="text-sm text-foreground">
            Scans USDC and MON every cycle and rebalances inside its bands.
          </p>
          <SectionLabel as="h4">Equipped</SectionLabel>
          <div className="flex flex-wrap gap-2">
            <Tag tone="legendary">Legendary</Tag>
            <Tag tone="rare">Rare</Tag>
            <Tag>Common</Tag>
          </div>
        </div>
      </Specimen>
    </Section>
  );
}

const WALLET_STATE_LABELS = {
  "logged-out": "Logged out",
  connecting: "Connecting",
  "wrong-chain": "Wrong chain",
  connected: "Connected",
  error: "Error",
} as const;

function WalletSection() {
  return (
    <Section id="wallet" title="Wallet and login">
      <Specimen
        name="Wallet button"
        note="The app shell's wallet control in every login state. On narrow screens the chain chip and error text hide; the action stays."
      >
        <div className="flex flex-col gap-4">
          {WALLET_STATES.map((state) => (
            <div
              key={state}
              data-testid={`login-state-${state}`}
              className="flex flex-col gap-2 rounded-lg border bg-surface p-3"
            >
              <span className="text-xs text-foreground-muted">{WALLET_STATE_LABELS[state]}</span>
              <WalletButton
                state={state}
                address={AGENT_WALLET}
                chainName="Monad (local fork)"
                walletName="MetaMask"
                errorMessage="The wallet rejected the login request."
                // A retryable error shows "Try again" only when there is an action to run.
                onConnect={() => undefined}
              />
            </div>
          ))}
          <div
            data-testid="login-state-connecting-cancel"
            className="flex flex-col gap-2 rounded-lg border bg-surface p-3"
          >
            <span className="text-xs text-foreground-muted">
              Connecting, waiting on the wallet (Cancel gives up)
            </span>
            <WalletButton state="connecting" onCancel={() => undefined} />
          </div>
          <div
            data-testid="login-state-connected-okx"
            className="flex flex-col gap-2 rounded-lg border bg-surface p-3"
          >
            <span className="text-xs text-foreground-muted">Connected with OKX Wallet</span>
            <WalletButton
              state="connected"
              address={AGENT_WALLET}
              chainName="Monad (local fork)"
              walletName="OKX Wallet"
              onDisconnect={() => undefined}
            />
          </div>
          <div
            data-testid="login-state-unavailable"
            className="flex flex-col gap-2 rounded-lg border bg-surface p-3"
          >
            <span className="text-xs text-foreground-muted">Error, login unavailable</span>
            <WalletButton
              state="error"
              errorLabel="Login unavailable"
              errorMessage="Wallet login is not configured."
            />
          </div>
        </div>
      </Specimen>
      <Specimen
        name="Wallet notice"
        note="Shown under the header while a connect waits on the wallet: what it is waiting for, and Cancel. A connect never spins without saying why. The warning tone says what is wrong in the wallet and how to fix it, such as transactions the local fork will never mine."
      >
        <div data-testid="login-state-waiting-notice">
          <WalletNotice
            title="Connecting your wallet"
            actions={
              <Button variant="secondary" size="sm">
                Cancel
              </Button>
            }
          >
            Waiting for MetaMask to answer. Unlock it, or cancel and connect again.
          </WalletNotice>
        </div>
        <div data-testid="wallet-notice-warning">
          <WalletNotice
            title="Your wallet has transactions the local fork will never mine"
            tone="warning"
          >
            It sent nonce 3, but the fork expects nonce 0, as happens after a fork reset. Reset your
            wallet&apos;s activity for the Monad (local fork) network, then try again.
          </WalletNotice>
        </div>
      </Specimen>
      <Specimen
        name="Wrong chain prompt"
        note="Shown above every page while the wallet is on another chain; nothing proceeds until it switches."
      >
        <div className="flex flex-col gap-4" data-testid="login-state-wrong-chain-prompt">
          <WrongChainPrompt targetChainName="Monad (local fork)" currentChainName="Ethereum" />
          <WrongChainPrompt targetChainName="Monad (local fork)" switching />
        </div>
      </Specimen>
      <Specimen
        name="Network switch outcomes"
        note="The switch button never fails silently: the prompt says the request is waiting in the wallet, that it was declined, or why it failed. A successful switch removes the prompt and shows a toast."
      >
        <div className="flex flex-col gap-4" data-testid="switch-outcomes">
          <WrongChainPrompt
            targetChainName="Monad (local fork)"
            currentChainName="Monad Testnet"
            switching
            status={{
              tone: "muted",
              text: "Approve adding Monad (local fork) in your wallet. Waiting for the wallet.",
            }}
          />
          <WrongChainPrompt
            targetChainName="Monad (local fork)"
            currentChainName="Monad Testnet"
            status={{ tone: "negative", text: "You declined the network switch in your wallet." }}
          />
          <WrongChainPrompt
            targetChainName="Monad (local fork)"
            currentChainName="Monad Testnet"
            status={{
              tone: "negative",
              text: "Your wallet still reports Monad Testnet. Some wallets, such as MetaMask, keep a separate network for each site: open your wallet on this page and choose Monad (local fork).",
            }}
          />
        </div>
      </Specimen>
    </Section>
  );
}

const MINT_STATE_LABELS: Readonly<Record<(typeof MINT_STATES)[number], string>> = {
  idle: "Idle",
  claiming: "Getting the claim",
  signing: "Signing in the wallet",
  minting: "Minting",
  "awaiting-reveal": "Waiting for reveal",
  revealed: "Revealed",
  rejected: "Rejected in wallet",
  "claim-refused": "Claim refused",
  error: "Error",
};

/** A token-bound account address for the specimens; not a real agent's. */
const SAMPLE_TBA = "0x6148e658098A14df34Cc79dB6b4128Dc367C7d3E";

function AgentSection() {
  return (
    <Section id="agents" title="Agents">
      <Specimen
        name="Slot marker"
        note="The skill slot hexagon. On a 3D model each one rides a named socket; without a model they sit on the art."
      >
        <div className="flex flex-wrap gap-6" data-testid="slot-states">
          {SLOT_STATES.map((state, i) => (
            <State key={state} label={state}>
              <SlotHex index={i} state={state} skillName="Momentum scanner" />
            </State>
          ))}
        </div>
      </Specimen>
      <Specimen
        name="Species art"
        note="The species image, a placeholder styled by tier while a species has no art, and the unrevealed placeholder. With slots, the tier's slots sit on the art."
      >
        <div
          className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5"
          data-testid="species-art"
        >
          <State label="Image, pro, 8 slots">
            <SpeciesArt image="/species/bee.webp" speciesName="Bee" tier="pro" slots={8} />
          </State>
          <State label="Placeholder, base">
            <SpeciesArt image={null} speciesName="Ant" tier="base" slots={3} />
          </State>
          <State label="Placeholder, medium">
            <SpeciesArt image={null} speciesName="Firefly" tier="medium" slots={5} />
          </State>
          <State label="Placeholder, pro">
            <SpeciesArt image={null} speciesName="Scorpion" tier="pro" />
          </State>
          <State label="Unrevealed">
            <SpeciesArt image={null} speciesName={null} tier={null} />
          </State>
        </div>
      </Specimen>
      <Specimen
        name="Viewer frame"
        note="The frame around the agent viewer: radial background, corner marks, a badge, tools and readouts. The 3D canvas, or the art, goes inside."
      >
        <div className="h-80" data-testid="viewer-frame">
          <ViewerFrame
            label="Agent viewer"
            badge={<Tag size="md">#14 Bee</Tag>}
            tools={
              <Tag tone="accent" size="md">
                2D
              </Tag>
            }
            readoutLeft="Pro · Bee"
            readoutRight="slots 0/8"
          >
            <div className="flex size-full items-center justify-center p-10">
              <SpeciesArt
                image={null}
                speciesName="Ant"
                tier="base"
                slots={3}
                className="max-w-56"
              />
            </div>
          </ViewerFrame>
        </div>
      </Specimen>
      <Specimen
        name="Mint button"
        note="Every state of minting: the claim, the wallet, the transaction, the reveal, and the three ways it ends early."
      >
        <div className={STATE_GRID}>
          {MINT_STATES.map((state) => (
            <div key={state} data-testid={`mint-state-${state}`}>
              <State label={MINT_STATE_LABELS[state]}>
                <MintButton
                  state={state}
                  agentId={14n}
                  revealedAs="Pro · Bee"
                  message={
                    state === "claim-refused"
                      ? "This wallet has already minted an agent"
                      : "The transaction reverted"
                  }
                  onMint={() => undefined}
                  onDismiss={() => undefined}
                />
              </State>
            </div>
          ))}
        </div>
      </Specimen>
      <Specimen
        name="Agent card"
        note="An agent NFT: token ID, tier, species, art, token-bound account and owner, with the environment. Before reveal the tier and species say so."
      >
        <div className="grid gap-4 sm:grid-cols-2" data-testid="agent-cards">
          <AgentCard
            agentId={14n}
            tier="pro"
            speciesName="Bee"
            image="/species/bee.webp"
            slots={8}
            tba={SAMPLE_TBA}
            owner={AGENT_WALLET}
            ownerEpoch={0n}
            environment="local fork"
          />
          <AgentCard
            agentId={15n}
            tier={null}
            speciesName={null}
            image={null}
            slots={0}
            tba={SAMPLE_TBA}
            owner={AGENT_WALLET}
            ownerEpoch={0n}
            environment="local fork"
          />
        </div>
      </Specimen>
      <Specimen
        name="Pending agent"
        note="An agent the wallet holds on chain that the platform cannot show in full yet: not yet in the index, or not yet revealed. It replaces any mint prompt for a wallet that has minted."
      >
        <div className="grid gap-4 sm:grid-cols-2" data-testid="pending-agents">
          <PendingAgentNotice agentId={2n} stage="indexing" />
          <PendingAgentNotice agentId={2n} stage="reveal" />
        </div>
      </Specimen>
      <Specimen
        name="All holdings"
        note="Every balance at each of an agent's addresses, named in plain words, with what it does there. What does nothing where it sits says so, and the owner can move it to their wallet when they can sign for it: waiting in the wallet, declined, a finished move whose balance has left, or the platform-only and stuck cases with no move."
      >
        <div className="grid gap-4 lg:grid-cols-2" data-testid="holdings-specimens">
          <HoldingsPanel
            network="Monad Testnet"
            onMove={() => undefined}
            addresses={[
              {
                role: "funding",
                address: SAMPLE_TBA,
                lines: [
                  {
                    symbol: "MON",
                    raw: 5n * 10n ** 17n,
                    decimals: 18,
                    use: "gas",
                    status: "in_use",
                  },
                  {
                    symbol: "USDC",
                    raw: 10_000_000n,
                    decimals: 6,
                    use: "credits",
                    status: "in_use",
                  },
                ],
              },
              {
                role: "token_bound",
                address: AGENT_WALLET,
                lines: [
                  {
                    symbol: "MON",
                    raw: 3n * 10n ** 18n,
                    decimals: 18,
                    use: null,
                    status: "movable",
                    move: { state: "waiting-wallet", text: "Confirm the transfer in your wallet." },
                  },
                  {
                    symbol: "USDC",
                    raw: 5_000_000n,
                    decimals: 6,
                    use: null,
                    status: "movable",
                    move: {
                      state: "rejected",
                      text: "You declined the request in your wallet. Nothing moved.",
                    },
                  },
                ],
              },
              {
                role: "personal_account",
                address: SAMPLE_TBA,
                lines: [
                  {
                    symbol: "USDC",
                    raw: 5_000_000n,
                    decimals: 6,
                    use: "trading",
                    status: "in_use",
                  },
                  { symbol: "WMON", raw: 0n, decimals: 18, use: "trading", status: "in_use" },
                ],
              },
            ]}
          />
          <HoldingsPanel
            network="Monad Testnet"
            addresses={[
              {
                role: "funding",
                address: SAMPLE_TBA,
                lines: [
                  {
                    symbol: "WMON",
                    raw: 2n * 10n ** 16n,
                    decimals: 18,
                    use: null,
                    status: "platform_only",
                  },
                ],
              },
              {
                role: "token_bound",
                address: AGENT_WALLET,
                lines: [],
                moved: [{ symbol: "MON", text: "Moved MON to your wallet.", hash: null }],
              },
              {
                role: "personal_account",
                address: null,
                lines: [],
              },
              {
                role: "older_account",
                address: SAMPLE_TBA,
                lines: [
                  {
                    symbol: "USDC",
                    raw: 100_000_000n,
                    decimals: 6,
                    use: null,
                    status: "older",
                  },
                ],
              },
            ]}
          />
        </div>
      </Specimen>
      <Specimen
        name="Tier card"
        note="One tier on the mint page: its slots, supply, what is left and the chance per mint, with its species. One-of-ones are marked. Informational: the tier is drawn at reveal."
      >
        <div className="grid gap-4 lg:grid-cols-3" data-testid="tier-cards">
          <TierCard
            tier="base"
            slots={3}
            total="600"
            remaining={null}
            remainingBps={0}
            odds={null}
            species={[
              { name: "Ant", image: null, total: 120, remaining: null },
              { name: "Tick", image: null, total: 120, remaining: null },
            ]}
          />
          <TierCard
            tier="medium"
            slots={5}
            total="300"
            remaining="0"
            remainingBps={0}
            odds="0%"
            soldOut
            species={[
              { name: "Firefly", image: null, total: 37, remaining: 0 },
              { name: "Moth", image: null, total: 38, remaining: 0 },
            ]}
          />
          <TierCard
            tier="pro"
            slots={8}
            total="100"
            remaining="98"
            remainingBps={9800}
            odds="9.8%"
            species={[
              { name: "Bee", image: "/species/bee.webp", total: 1, remaining: 0 },
              { name: "Praying mantis", image: null, total: 1, remaining: 1 },
              { name: "Dragonfly", image: null, total: 12, remaining: 11 },
            ]}
          />
        </div>
      </Specimen>
      <Specimen
        name="Mint panel"
        note="The mint page's panel in every state around the mint button: not open here, logged out, connecting, wrong network, checking, a failed read, not eligible (checked before the click), ready, already minted, sold out, waiting for reveal and revealed."
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="mint-panels">
          {MINT_PANEL_STATES.map((state) => (
            <div key={state} className="flex flex-col gap-2" data-testid={`mint-panel-${state}`}>
              <span className="text-xs text-foreground-muted">{state}</span>
              <MintPanel
                state={state}
                mint={{
                  state:
                    state === "revealed"
                      ? "revealed"
                      : state === "awaiting-reveal"
                        ? "awaiting-reveal"
                        : "idle",
                  agentId: 14n,
                  revealedAs: "Pro · Bee",
                  onMint: () => undefined,
                }}
                agent={
                  state === "awaiting-reveal"
                    ? { id: 14n, tier: null, speciesName: null, image: null }
                    : { id: 14n, tier: "pro", speciesName: "Bee", image: "/species/bee.webp" }
                }
                agentHref="/design#agents"
                message={
                  state === "not-eligible"
                    ? "This wallet is not on the beta mint allowlist."
                    : "AgentNFT is not deployed on Monad Testnet yet."
                }
                targetNetwork="Monad (local fork)"
                walletNetwork="Ethereum"
                maxSupply="1,000"
                revealNote="On the local fork, the reveal keeper reveals it within about 15 seconds."
                onConnect={() => undefined}
                onRetry={() => undefined}
              />
            </div>
          ))}
        </div>
      </Specimen>
      <Specimen
        name="Runtime status"
        note="Whether the orchestrator has provisioned an agent: its config rendered and its LiteLLM key created (P1-U5)."
      >
        <div className="flex flex-wrap gap-2">
          {RUNTIME_STATUSES.map((status) => (
            <RuntimeStatusBadge key={status} status={status} />
          ))}
        </div>
      </Specimen>
      <Specimen
        name="Task result"
        note="A task run in an agent's sandbox, with its structured result; the dev console's no-op task uses it."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <TaskResult
            title="No-op task, Alpha Agent #7"
            status="succeeded"
            fields={[
              { label: "Reply", value: "NOOP_OK" },
              { label: "Tier", value: "Medium, 5 slots, tier-medium@0" },
              { label: "Model calls", value: "1 of 1 succeeded" },
              { label: "Sandbox", value: "Stopped" },
              { label: "Time", value: "Sandbox 0.7 s, Hermes 12.7 s, run 3.1 s" },
            ]}
          />
          <div className="flex flex-col gap-4">
            <TaskResult title="No-op task, Alpha Agent #8" status="running" />
            <TaskResult
              title="No-op task, Alpha Agent #9"
              status="failed"
              error="Agent 9 already has a sandbox running."
            />
          </div>
        </div>
      </Specimen>
      <Specimen
        name="Tool call status"
        note="Each tool call an agent made: answered and charged, failed with its charge reversed, or refused before it ran (P1-U7). The code, if any, is in the title."
      >
        <div className="flex flex-wrap gap-2">
          {TOOL_CALL_STATUSES.map((status) => (
            <ToolCallStatusBadge
              key={status}
              status={status}
              code={status === "refused" ? "PRIVATE_ADDRESS" : null}
            />
          ))}
        </div>
      </Specimen>
      <Specimen
        name="Activity feed"
        note="The narrator's owner-readable entries, newest first; every number in an entry is checked against the agent's records, and a fixed template writes the entry when a narration is rejected (P1-U7)."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <ActivityFeed
            label="Activity of Alpha Agent #7"
            entries={[
              {
                entryId: "e2",
                text: "Alpha Agent #7 finished a Scan. It ran 2 web searches and read 1 page. Candidates: WMON DEX_VOLUME_UP (55%). Tools cost 0.022 USDC; 4.978 USDC of credits left.",
                at: "2026-10-06T16:42:00.000Z",
                renderedBy: "template",
              },
              {
                entryId: "e1",
                text: "Agent #7 searched for Monad DEX volume twice, read one report and flagged WMON at 55% confidence; tools cost 0.022 USDC.",
                at: "2026-10-06T10:42:00.000Z",
                renderedBy: "narrator",
              },
            ]}
          />
          <ActivityFeed label="Activity of Alpha Agent #8" entries={[]} empty="No Scans yet." />
        </div>
      </Specimen>
      <Specimen
        name="Run status"
        note="What an owner's agent is doing, on My Agents (P1-U9); the meaning is in the title. Paused means research only: safety keeps running."
      >
        <div className="flex flex-wrap gap-2">
          {RUN_STATUSES.map((status) => (
            <RunStatusBadge key={status} status={status} />
          ))}
        </div>
      </Specimen>
      <Specimen
        name="QR code"
        note="Encodes exactly the value given, an address, in the tokens: dark modules on a light quiet zone, which every scanner reads."
      >
        <QrCode
          value="0x9F8e2B1C0d3a4E5f60718293A4B5c6D7E8f90a1B"
          label="QR code of an example funding address"
          className="max-w-32"
        />
      </Specimen>
      <Specimen
        name="Fund your agent"
        note="The funding address with its copy button and QR code, the credits it holds, USDC held above the beta cap (P1-U9), and the trading account's value with a link to the portfolio, or that none is open yet (P2-U7)."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <FundAgentPanel
            agentName="Alpha Agent #7"
            funding={{
              fundingAddress: "0x9F8e2B1C0d3a4E5f60718293A4B5c6D7E8f90a1B",
              spendableUsdcE6: 4_994_400n,
              heldUsdcE6: 2_000_000n,
            }}
            trading={{
              hasAccount: true,
              valueUsdcE6: 40_000_000n,
              usdcShareBps: 7_500,
              mode: "NORMAL",
            }}
            tradingAction={
              <Button size="sm" variant="secondary">
                Open portfolio
              </Button>
            }
          />
          <FundAgentPanel
            agentName="Alpha Agent #8"
            funding={null}
            trading={{ hasAccount: false, valueUsdcE6: null }}
          />
        </div>
      </Specimen>
      <Specimen
        name="Spend"
        note="Credits spent in the last 24 hours and the recent charges: model calls, tool calls, and charges given back for tool calls that were not answered."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <SpendPanel
            agentName="Alpha Agent #7"
            spent24hUsdcE6={22_000n}
            charges={[
              {
                entryId: "c3",
                at: "2026-10-06T16:42:00.000Z",
                kind: "reversal",
                label: "web_search",
                amountUsdcE6: -12_000n,
              },
              {
                entryId: "c2",
                at: "2026-10-06T16:41:00.000Z",
                kind: "tool",
                label: "web_search",
                amountUsdcE6: 12_000n,
              },
              {
                entryId: "c1",
                at: "2026-10-06T16:40:00.000Z",
                kind: "model",
                label: "scan-cheap",
                amountUsdcE6: 10_000n,
              },
            ]}
          />
          <SpendPanel agentName="Alpha Agent #8" spent24hUsdcE6={0n} charges={[]} />
        </div>
      </Specimen>
    </Section>
  );
}

function FormsSection() {
  return (
    <Section id="forms" title="Form controls">
      <Specimen name="Input">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Max position size" hint="In USDC, up to 10% of the account">
            {(control) => <Input {...control} placeholder="1,000" inputMode="decimal" />}
          </Field>
          <Field label="Hover">
            {(control) => <Input {...control} defaultValue="1,000" data-force="hover" />}
          </Field>
          <Field label="Focus">
            {(control) => <Input {...control} defaultValue="1,000" data-force="focus" />}
          </Field>
          <Field label="Disabled">
            {(control) => <Input {...control} defaultValue="1,000" disabled />}
          </Field>
          <Field label="Daily loss limit" error="Must be at most 10% of the account">
            {(control) => <Input {...control} defaultValue="25,000" />}
          </Field>
          <Field label="Loading">{() => <Skeleton className="h-9 w-full" />}</Field>
        </div>
      </Specimen>
      <Specimen
        name="Select"
        note="The open state is shown as a static menu; the trigger opens the real one."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Risk level">
            {(control) => (
              <Select defaultValue="balanced">
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="conservative">Conservative</SelectItem>
                  <SelectItem value="balanced">Balanced</SelectItem>
                  <SelectItem value="aggressive">Aggressive</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label="Focus">
            {(control) => (
              <Select defaultValue="balanced">
                <SelectTrigger {...control} data-force="focus">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="balanced">Balanced</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label="Disabled">
            {(control) => (
              <Select defaultValue="balanced" disabled>
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="balanced">Balanced</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label="Allowed asset" error="Choose at least one asset">
            {(control) => (
              <Select>
                <SelectTrigger {...control}>
                  <SelectValue placeholder="Choose an asset" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="usdc">USDC</SelectItem>
                  <SelectItem value="wmon">WMON</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
          <State label="Open">
            <SelectMenuPreview
              items={["Conservative", "Balanced", "Aggressive"]}
              selected="Balanced"
              highlighted="Aggressive"
            />
          </State>
        </div>
      </Specimen>
      <Specimen name="Slider">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <State label="Default" className="w-full">
            <Slider thumbLabel="Target return" defaultValue={[40]} max={100} step={1} />
          </State>
          <State label="Hover" className="w-full">
            <Slider
              thumbLabel="Target return, hover"
              defaultValue={[55]}
              max={100}
              forceThumb="hover"
            />
          </State>
          <State label="Focus" className="w-full">
            <Slider
              thumbLabel="Target return, focus"
              defaultValue={[70]}
              max={100}
              forceThumb="focus"
            />
          </State>
          <State label="Disabled" className="w-full">
            <Slider thumbLabel="Target return, disabled" defaultValue={[25]} max={100} disabled />
          </State>
        </div>
      </Specimen>
      <Specimen name="Tabs">
        <div className="flex flex-col gap-4">
          <Tabs defaultValue="base">
            <TabsList aria-label="League">
              <TabsTrigger value="base">Base</TabsTrigger>
              <TabsTrigger value="medium" data-force="hover">
                Medium (hover)
              </TabsTrigger>
              <TabsTrigger value="pro" data-force="focus">
                Pro (focus)
              </TabsTrigger>
              <TabsTrigger value="season" disabled>
                Next season
              </TabsTrigger>
            </TabsList>
            <TabsContent value="base" className="text-sm text-foreground-muted">
              Base league: agents with three skill slots.
            </TabsContent>
            <TabsContent value="medium" className="text-sm text-foreground-muted">
              Medium league: five slots.
            </TabsContent>
            <TabsContent value="pro" className="text-sm text-foreground-muted">
              Pro league: eight slots.
            </TabsContent>
          </Tabs>
        </div>
      </Specimen>
    </Section>
  );
}

function OverlaysSection() {
  return (
    <Section id="overlays" title="Overlays and feedback">
      <Specimen
        name="Dialog"
        note="The open state is shown inline; the button opens the real dialog."
      >
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <State label="Open">
            <DialogSurface
              title="Deploy this build?"
              description="UNIT-07 starts trading with the new build at its next cycle."
            >
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost">Cancel</Button>
                <Button>Deploy build</Button>
              </div>
            </DialogSurface>
          </State>
          <State label="Trigger">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="secondary">Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Deploy this build?</DialogTitle>
                  <DialogDescription>
                    UNIT-07 starts trading with the new build at its next cycle.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="ghost">Cancel</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button>Deploy build</Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </State>
        </div>
      </Specimen>
      <Specimen name="Tooltip">
        <div className="flex flex-wrap items-start gap-6">
          <State label="Open">
            <TooltipSurface>
              Max drawdown is the largest drop from a peak in the period.
            </TooltipSurface>
          </State>
          <State label="Trigger">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost">What is drawdown?</Button>
              </TooltipTrigger>
              <TooltipContent>
                Max drawdown is the largest drop from a peak in the period.
              </TooltipContent>
            </Tooltip>
          </State>
        </div>
      </Specimen>
      <Specimen name="Toast">
        <div className="grid items-start gap-4 lg:grid-cols-4">
          <State label="Info">
            <ToastSurface tone="info" title="UNIT-07 gained 3 watchers" />
          </State>
          <State label="Success">
            <ToastSurface
              tone="success"
              title="Build deployed"
              description="UNIT-07 runs bot v14 from its next cycle."
            />
          </State>
          <State label="Error">
            <ToastSurface
              tone="error"
              title="Credits low"
              description="UNIT-07 has 2 days of credits left."
            />
          </State>
          <State label="Trigger">
            <Button
              variant="secondary"
              onClick={() =>
                toast.success("Build deployed", {
                  description: "UNIT-07 runs bot v14 from its next cycle.",
                })
              }
            >
              Show a toast
            </Button>
          </State>
        </div>
      </Specimen>
      <Specimen name="Skeleton" note="Loading placeholders, sized from the spacing scale.">
        <Card className="max-w-dialog">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
          <Skeleton className="h-20 w-full" />
        </Card>
      </Specimen>
      <Specimen name="Empty state">
        <EmptyState
          icon={Boxes}
          title="No skills yet"
          description="Browse the marketplace to equip your first skill."
          action={<Button variant="secondary">Browse the marketplace</Button>}
        />
      </Specimen>
    </Section>
  );
}

function DataSection() {
  return (
    <Section id="data" title="Data display">
      <Specimen name="Card">
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>UNIT-07</CardTitle>
              <CardDescription>Medium tier, five skill slots</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill kind="agent_state" value="RUNNING" />
                <StatusPill kind="account_mode" value="NORMAL" />
                <RiskBadge level="balanced" />
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <span>
                  30d return <span className="numeric text-positive">+3.1%</span>
                </span>
                <span>
                  Max drawdown <span className="numeric text-negative">4.2%</span>
                </span>
              </div>
            </CardContent>
            <CardFooter>
              <Button size="sm">Configure</Button>
              <Button size="sm" variant="ghost">
                View profile
              </Button>
            </CardFooter>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Equipped skills</CardTitle>
              <CardDescription>Public build card</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {SKILLS.map((skill) => (
                  <Badge key={skill}>{skill}</Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </Specimen>
      <Specimen name="Stat bar" note="Label, value, bar and an optional preview delta.">
        <Card className="max-w-dialog">
          <StatBar
            label="Win rate"
            value="58%"
            fillBps={5_800}
            delta={{ direction: "positive", text: "4%" }}
          />
          <StatBar label="30d return" value="+3.1%" fillBps={6_200} />
          <StatBar
            label="Max drawdown"
            value="4.2%"
            fillBps={2_100}
            delta={{ direction: "negative", text: "0.8%" }}
          />
          <StatBar label="Risk score" value="42" fillBps={4_200} />
        </Card>
      </Specimen>
      <Specimen
        name="Status pill"
        note="Every canonical account mode, agent state, display flag and signer transaction state from packages/domain."
      >
        <div className="flex flex-col gap-3">
          <State label="Account modes">
            {ACCOUNT_MODES.map((mode) => (
              <StatusPill key={mode} kind="account_mode" value={mode} />
            ))}
          </State>
          <State label="Agent states">
            {AGENT_STATES.map((state) => (
              <StatusPill key={state} kind="agent_state" value={state} />
            ))}
          </State>
          <State label="Display flags">
            {DISPLAY_FLAGS.map((flag) => (
              <StatusPill key={flag} kind="display_flag" value={flag} />
            ))}
          </State>
          <State label="Transaction states">
            {TRANSACTION_STATES.map((state) => (
              <StatusPill key={state} kind="transaction" value={state} />
            ))}
          </State>
          <State label="Intent states">
            {INTENT_STATES.map((state) => (
              <StatusPill key={state} kind="intent" value={state} />
            ))}
          </State>
          <State label="Arming states">
            {ARMING_STATES.map((state) => (
              <StatusPill key={state} kind="arming" value={state} />
            ))}
          </State>
        </div>
      </Specimen>
      <Specimen name="Risk badge">
        <div className="flex flex-wrap gap-3">
          {RISK_LEVELS.map((level) => (
            <RiskBadge key={level} level={level} />
          ))}
        </div>
      </Specimen>
      <Specimen name="Demand counter">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <DemandCounter icon={Eye} label="Watchers" count={41} dailyChange={3} />
          <DemandCounter icon={Users} label="Depositors" count={6} dailyChange={1} />
          <DemandCounter icon={Radio} label="Signal buyers" count={2} />
          <DemandCounter icon={Bot} label="Build copies" count={1_204} dailyChange={-2} />
        </div>
      </Specimen>
      <Specimen
        name="Amount and address"
        note="Bigint amounts through formatAmount; addresses shortened with a copy button."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <State label="Balance">
            <AmountDisplay
              value={12_480_000_000n}
              decimals={6}
              minFractionDigits={2}
              symbol="USDC"
            />
          </State>
          <State label="Token amount">
            <AmountDisplay
              value={1_234_567_800_000_000_000_000n}
              decimals={18}
              maxFractionDigits={4}
              symbol="WMON"
            />
          </State>
          <State label="Gain">
            <AmountDisplay
              value={386_880_000n}
              decimals={6}
              minFractionDigits={2}
              signed
              colorBySign
              symbol="USDC"
            />
          </State>
          <State label="Loss">
            <AmountDisplay
              value={-524_160_000n}
              decimals={6}
              minFractionDigits={2}
              colorBySign
              symbol="USDC"
            />
          </State>
          <State label="Address">
            <AddressDisplay address={AGENT_WALLET} label="Agent wallet" />
          </State>
          <State label="Copy hover">
            <AddressDisplay address={AGENT_WALLET} label="Agent wallet" forceState="hover" />
          </State>
          <State label="Copy focus">
            <AddressDisplay address={AGENT_WALLET} label="Agent wallet" forceState="focus" />
          </State>
          <State label="Copied">
            <AddressDisplay address={AGENT_WALLET} label="Agent wallet" forceState="copied" />
          </State>
        </div>
      </Specimen>
      <Specimen name="Table">
        <Table label="Leaderboard sample">
          <TableCaption>Base league, season 1</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Rank</TableHead>
              <TableHead scope="col">Agent</TableHead>
              <TableHead scope="col">30d return</TableHead>
              <TableHead scope="col">Max drawdown</TableHead>
              <TableHead scope="col">TVL</TableHead>
              <TableHead scope="col">Watchers</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {LEADERBOARD.map((row, i) => (
              <TableRow
                key={row.agent}
                data-force={i === 1 ? "hover" : undefined}
                aria-selected={i === 0 ? true : undefined}
              >
                <TableCell className="numeric">{row.rank}</TableCell>
                <TableCell className="font-medium">{row.agent}</TableCell>
                <TableCell
                  className={cn("numeric", row.returnBps >= 0 ? "text-positive" : "text-negative")}
                >
                  {pct(row.returnBps)}
                </TableCell>
                <TableCell className="numeric text-negative">
                  {(row.drawdownBps / 100).toFixed(1)}%
                </TableCell>
                <TableCell>
                  <AmountDisplay
                    value={row.tvlE6}
                    decimals={6}
                    minFractionDigits={2}
                    symbol="USDC"
                  />
                </TableCell>
                <TableCell className="numeric">{row.watchers}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-xs text-foreground-muted">
          Row 1 is selected and row 2 shows the hover state.
        </p>
      </Specimen>
      <Specimen
        name="Table, stacked on narrow screens"
        note="With stack, below 640px each row becomes a block and each cell shows its column's name, so a wide table never scrolls sideways on a phone."
      >
        <Table stack label="Stacked table sample">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">Request</TableHead>
              <TableHead scope="col">Transaction</TableHead>
              <TableHead scope="col">Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell label="State">
                <StatusPill kind="transaction" value="reconciled" />
              </TableCell>
              <TableCell label="Request">
                Buy WMON with{" "}
                <AmountDisplay
                  value={5_000_000n}
                  decimals={6}
                  minFractionDigits={2}
                  symbol="USDC"
                />
              </TableCell>
              <TableCell label="Transaction" className="numeric text-xs">
                0x4be1f5c0a9e2... nonce 3
              </TableCell>
              <TableCell label="Outcome">In the ledger</TableCell>
            </TableRow>
            <TableRow>
              <TableCell label="State">
                <StatusPill kind="transaction" value="failed" />
              </TableCell>
              <TableCell label="Request">
                Buy WMON with{" "}
                <AmountDisplay
                  value={90_000_000n}
                  decimals={6}
                  minFractionDigits={2}
                  symbol="USDC"
                />
              </TableCell>
              <TableCell label="Transaction" className="numeric text-xs">
                not signed
              </TableCell>
              <TableCell label="Outcome">
                <ReasonMessage code="TRADE_SIZE_EXCEEDED" />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Specimen>
      <Specimen
        name="Reason message"
        note='Every policy reason code from packages/domain, as the owner reads it under "why the agent did not trade".'
      >
        <div className="grid gap-3 md:grid-cols-2">
          {REJECTION_CODES.map((code) => (
            <ReasonMessage key={code} code={code} />
          ))}
        </div>
        <SectionLabel>The trade flow&apos;s own reasons (P2-U6)</SectionLabel>
        <div className="grid gap-3 md:grid-cols-2">
          {TRADE_FLOW_CODES.map((code) => (
            <ReasonMessage key={code} code={code} />
          ))}
        </div>
        <SectionLabel>The signer&apos;s own reasons (P2-U4)</SectionLabel>
        <div className="grid gap-3 md:grid-cols-2">
          {SIGNER_REASON_CODES.map((code) => (
            <ReasonMessage key={code} code={code} />
          ))}
        </div>
      </Specimen>
      <Specimen name="Beta banner" note="The app shell shows it on every page.">
        <BetaBanner environment="fork" className="rounded-md border" />
      </Specimen>
    </Section>
  );
}

const DS_ACCOUNT = "0x4d2C9a1B3e5F60718293a4b5C6d7e8F90a1b2C3d";
const DS_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const DS_WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const DS_POSITIONS: PositionsView = {
  usdc: 30_000_000n,
  wmon: 400n * 10n ** 18n,
  wmonValueUsdc: 10_000_000n,
  totalUsdc: 40_000_000n,
  usdcShareBps: 7_500,
  wmonShareBps: 2_500,
  mode: "NORMAL",
  drawdownBps: 120,
  peak7d: "1.0125",
  price: { monUsd: "0.0250", ageSeconds: 20, usable: true, reason: "OK" },
};

const noop = () => undefined;

function PortfolioSection() {
  return (
    <Section id="portfolio" title="Portfolio">
      <Specimen
        name="Portfolio overview"
        note="The allocation by value as a donut (USDC steel, WMON lime), the total value, each asset's share, the account's mode and the price's freshness at a glance; unknown while WMON is held and its price is unusable."
      >
        <div className="flex flex-col gap-6">
          <PortfolioOverview positions={DS_POSITIONS} />
          <PortfolioOverview
            positions={{
              ...DS_POSITIONS,
              wmonValueUsdc: null,
              totalUsdc: null,
              usdcShareBps: null,
              wmonShareBps: null,
              mode: "REDUCE_ONLY",
              price: { monUsd: null, ageSeconds: 900, usable: false, reason: "STALE" },
            }}
          />
        </div>
      </Specimen>
      <Specimen
        name="The account on the fund agent's set"
        note="After the F-U11 playtest (A-80): the account at a glance across every held token, with the total, the mode, the drawdown and the prices' state; and the older v2 account the agent no longer trades, with one action that moves everything to the owner's wallet, waiting while it runs, and empty once it is."
      >
        <div className="flex flex-col gap-6" data-testid="fund-portfolio-specimens">
          <FundOverview
            rows={WIN_ROWS}
            totalValueUsdcE6="104788000"
            mode="NORMAL"
            drawdownBps={120}
            prices={{ priced: 3, held: 4, oldestAgeSeconds: 20 }}
          />
          <div className="grid gap-6 lg:grid-cols-3">
            <OlderAccountCard
              account={DS_ACCOUNT}
              lines={[
                { symbol: "USDC", decimals: 6, raw: 100_000_000n, claimableRaw: 0n },
                { symbol: "WMON", decimals: 18, raw: 0n, claimableRaw: 2n * 10n ** 18n },
              ]}
              mode="NORMAL"
              busy={false}
              onWithdrawAll={noop}
              onClaim={noop}
            />
            <OlderAccountCard
              account={DS_ACCOUNT}
              lines={[{ symbol: "USDC", decimals: 6, raw: 100_000_000n, claimableRaw: 0n }]}
              mode="PAUSED"
              busy
              onWithdrawAll={noop}
              status={
                <WalletActionStatus
                  state="waiting-wallet"
                  text="Confirm in your wallet: withdraw 100 USDC to your wallet."
                  hash={null}
                />
              }
            />
            <OlderAccountCard
              account={DS_ACCOUNT}
              lines={[]}
              mode={null}
              busy={false}
              onWithdrawAll={noop}
            />
          </div>
        </div>
      </Specimen>
      <Specimen
        name="Allocation chart and bar"
        note="The donut on the portfolio and the compact bar on an agent's card: all USDC, mixed, and an empty account."
      >
        <div className="grid gap-6 lg:grid-cols-3">
          <AllocationChart usdcShareBps={10_000} wmonShareBps={0} totalUsdc={20_000_000n} />
          <AllocationChart usdcShareBps={4_000} wmonShareBps={6_000} totalUsdc={20_000_000n} />
          <AllocationChart usdcShareBps={0} wmonShareBps={0} totalUsdc={0n} />
          <AllocationBar usdcShareBps={7_500} />
          <AllocationBar usdcShareBps={10_000} />
          <AllocationBar usdcShareBps={null} />
        </div>
      </Specimen>
      <Specimen
        name="Gas in the wallet"
        note="The wallet's MON for gas, and the warning when it is too low to arm, deposit or withdraw."
      >
        <div className="flex flex-col gap-3">
          <GasNotice
            monWei={500_000_000_000_000_000n}
            lowBelowWei={10n ** 16n}
            network="Monad (local fork)"
          />
          <GasNotice monWei={10n ** 14n} lowBelowWei={10n ** 16n} network="Monad (local fork)" />
        </div>
      </Specimen>
      <Specimen
        name="Add credits"
        note="The credits and the room left under the per-agent cap; an amount over the cap says how much is held (not lost); an amount over the wallet's balance is refused before sending."
      >
        <div className="grid gap-6 lg:grid-cols-3">
          <AddCreditsPanel
            agentName="Alpha Agent #7"
            creditsUsdcE6={4_994_400n}
            capUsdcE6={50_000_000n}
            walletUsdcE6={70_000_000n}
            amountText="5"
            onAmountChange={noop}
            onAdd={noop}
          />
          <AddCreditsPanel
            agentName="Alpha Agent #7"
            creditsUsdcE6={45_000_000n}
            capUsdcE6={50_000_000n}
            walletUsdcE6={70_000_000n}
            amountText="10"
            onAmountChange={noop}
            onAdd={noop}
            status={
              <WalletActionStatus
                state="waiting-wallet"
                text="Waiting for your wallet: Send 10 USDC to the funding address."
              />
            }
          />
          <AddCreditsPanel
            agentName="Alpha Agent #7"
            creditsUsdcE6={0n}
            capUsdcE6={50_000_000n}
            walletUsdcE6={2_000_000n}
            amountText="3"
            onAmountChange={noop}
            onAdd={noop}
          />
        </div>
      </Specimen>
      <Specimen
        name="Positions"
        note="USDC and WMON held, their value at the oracle price and share of the account, the account's mode, the drawdown from its 7-day peak, and the price's age. With the price unavailable, values read as unknown and the age gives the oracle's reason."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <PositionsPanel positions={DS_POSITIONS} />
          <PositionsPanel
            positions={{
              ...DS_POSITIONS,
              wmonValueUsdc: null,
              totalUsdc: null,
              usdcShareBps: null,
              wmonShareBps: null,
              mode: "PAUSED",
              drawdownBps: null,
              price: { monUsd: null, ageSeconds: 900, usable: false, reason: "STALE" },
            }}
          />
        </div>
      </Specimen>
      <Specimen
        name="Beta deposit limits"
        note="How much this account and the whole platform have taken under their caps, and the room left; a wallet not on the allowlist is named before any transaction."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <CapsPanel
            caps={{
              personalCapUsdc: 100_000_000n,
              principalUsdc: 40_000_000n,
              platformCapUsdc: 2_000_000_000n,
              platformTotalUsdc: 250_000_000n,
              roomUsdc: 60_000_000n,
              allowlisted: true,
            }}
          />
          <CapsPanel
            caps={{
              personalCapUsdc: 100_000_000n,
              principalUsdc: 0n,
              platformCapUsdc: 2_000_000_000n,
              platformTotalUsdc: 1_990_000_000n,
              roomUsdc: 10_000_000n,
              allowlisted: false,
            }}
          />
        </div>
      </Specimen>
      <Specimen
        name="Wallet action status"
        note="Every wallet transaction says where it is: checking the network, waiting in the wallet, confirming, confirmed, declined, or failed with the contract's reason."
      >
        <div className="flex flex-col gap-3">
          <WalletActionStatus state="checking" text="Checking your wallet's network." />
          <WalletActionStatus
            state="waiting-wallet"
            text="Waiting for your wallet: Approve 25 USDC (step 1 of 2)."
          />
          <WalletActionStatus
            state="confirming"
            text="Sent. Waiting for the network to confirm (step 2 of 2)."
            hash={`0x${"7d".repeat(32)}`}
          />
          <WalletActionStatus state="confirmed" text="Deposited 25 USDC." />
          <WalletActionStatus
            state="rejected"
            text="You declined the request in your wallet; nothing was sent."
          />
          <WalletActionStatus
            state="failed"
            text="The account is paused, so it takes no deposits. Withdrawals still work."
          />
        </div>
      </Specimen>
      <Specimen
        name="Arming card"
        note="Not armed (with why the last arming ended), awaiting the first approval, and armed with the grant's expiry and a renewal reminder; the page puts Arm, Disarm or Renew in its actions."
      >
        <div className="grid gap-6 lg:grid-cols-3">
          <ArmingCard
            agentName="Alpha Agent #7"
            arming={{
              state: "unarmed",
              validUntilDate: null,
              renewalDue: false,
              endedMessage: "The owner disarmed the agent.",
              fundingAddress: null,
            }}
            actions={<Button size="sm">Arm</Button>}
          />
          <ArmingCard
            agentName="Alpha Agent #7"
            arming={{
              state: "awaiting_first_trade",
              validUntilDate: "2026-11-06",
              renewalDue: false,
              endedMessage: null,
              fundingAddress: "0x9F8e2B1C0d3a4E5f60718293A4B5c6D7E8f90a1B",
            }}
            actions={
              <Button size="sm" variant="danger">
                Disarm
              </Button>
            }
          />
          <ArmingCard
            agentName="Alpha Agent #7"
            arming={{
              state: "armed",
              validUntilDate: "2026-10-09",
              renewalDue: true,
              endedMessage: null,
              fundingAddress: "0x9F8e2B1C0d3a4E5f60718293A4B5c6D7E8f90a1B",
            }}
            actions={
              <>
                <Button size="sm" variant="secondary">
                  Renew
                </Button>
                <Button size="sm" variant="danger">
                  Disarm
                </Button>
              </>
            }
          />
        </div>
      </Specimen>
      <Specimen
        name="Approval card"
        note="A trade waiting for the owner, with every financial field from the intent itself: the most it sells, the rule for the least it receives, the quote, the expiry, the account, the chain and both tokens' addresses."
      >
        <ApprovalCard
          approval={{
            intentId: "intent-6f1c2d9e-7b1a-4c3e-9d2f-1a2b3c4d5e6f",
            account: DS_ACCOUNT,
            chainName: "Monad (local fork)",
            chainId: 143143,
            sell: { asset: "USDC", token: DS_USDC, amount: 2_500_000n },
            buy: { asset: "WMON", token: DS_WMON },
            expectedOut: 99_900_000_000_000_000_000n,
            minOut: null,
            expiresAt: "2026-10-07T12:36:00.000Z",
            reason: "Add a little WMON while the price is near its weekly low.",
            arms: true,
          }}
          actions={
            <>
              <Button size="sm">Approve and arm</Button>
              <Button size="sm" variant="secondary">
                Reject
              </Button>
            </>
          }
        />
      </Specimen>
      <Specimen
        name="Recent trades"
        note="Proposals and trades with their state, amounts, settlement and transaction hash; an empty list says where trades come from."
      >
        <div className="flex flex-col gap-6">
          <RecentTrades
            trades={[
              {
                intentId: "t2",
                status: "submitted",
                sell: { asset: "USDC", amount: 2_000_000n },
                buy: "WMON",
                amountOut: null,
                txHash: `0x${"a1".repeat(32)}`,
                approvedBy: "auto",
                createdAt: "2026-10-07T12:10:00.000Z",
                settledAt: null,
              },
              {
                intentId: "t1",
                status: "reconciled",
                sell: { asset: "USDC", amount: 1_000_000n },
                buy: "WMON",
                amountOut: 39_940_000_000_000_000_000n,
                txHash: `0x${"7d".repeat(32)}`,
                approvedBy: "owner",
                createdAt: "2026-10-07T11:58:00.000Z",
                settledAt: "2026-10-07T11:58:09.000Z",
              },
              {
                intentId: "t0",
                status: "cancelled",
                sell: { asset: "USDC", amount: 15_000_000n },
                buy: "WMON",
                amountOut: null,
                txHash: null,
                approvedBy: null,
                createdAt: "2026-10-07T11:50:00.000Z",
                settledAt: null,
              },
            ]}
          />
          <RecentTrades trades={[]} />
        </div>
      </Specimen>
      <Specimen
        name="Why the agent did not trade"
        note="Each blocked trade's reasons in the owner's words, with how and when each may clear; nothing blocked reads as such."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <WhyNotTraded
            reasons={[
              {
                code: "TRADE_SIZE_EXCEEDED",
                clears: "by_changing_the_trade",
                clearsAt: null,
                hint: "Propose at most 4 USDC.",
                at: "2026-10-07T12:20:00.000Z",
              },
              {
                code: "DAILY_TRADE_LIMIT",
                clears: "by_waiting",
                clearsAt: "2026-10-08T09:15:00.000Z",
                hint: "The oldest trade in the window leaves it then.",
                at: "2026-10-07T12:18:00.000Z",
              },
              {
                code: "GAS_UNFUNDED",
                clears: "by_the_owner",
                clearsAt: null,
                hint: "Send a little MON to the agent's funding address for gas.",
                at: "2026-10-07T12:12:00.000Z",
              },
            ]}
          />
          <WhyNotTraded
            reasons={[]}
            armingEnded="The agent is not armed, so each trade waits for the owner's approval."
          />
        </div>
      </Specimen>
      <Specimen
        name="Plan card"
        note="A proposed portfolio against the plan in force (F-U9): each position's action, weights, thesis and exit plan, the sources by class, the skeptic's verdict, the evidence strength, the platform's checks and the estimated cost to move. A waiting one carries the owner's buttons."
      >
        <div className="flex flex-col gap-6">
          <PlanCard
            view={{
              proposalId: "prop-00000000-0000-4000-8000-000000000001",
              status: "pending_owner",
              needsApproval: true,
              cashTargetBps: 6_000,
              currentCashBps: 7_000,
              positions: [
                {
                  token: DS_WMON,
                  symbol: "WMON",
                  targetWeightBps: 2_000,
                  bandBps: 300,
                  currentWeightBps: 2_500,
                  action: "TRIM",
                  thesis: "WMON keeps its depth while MON's volatility settles under the brake.",
                  killCriterion: "MON's 24-hour volatility stays above 150% for 3 days.",
                  recheckAt: "2026-10-24",
                  trimAboveBps: null,
                  confidence: "medium",
                  sources: { onchain: 2, market: 2, primary: 0, news: 1, social: 0 },
                  verdict: "STANDS",
                  reason: "The thesis stands but the account is above its weight.",
                },
                {
                  token: DS_USDC,
                  symbol: "WBTC",
                  targetWeightBps: 2_000,
                  bandBps: 300,
                  currentWeightBps: null,
                  action: "ADD",
                  thesis:
                    "WBTC tracks bitcoin while its pool stays deep enough for this account's legs.",
                  killCriterion: "The deepest pool's liquidity halves.",
                  recheckAt: "2026-11-01",
                  trimAboveBps: 3_000,
                  confidence: "medium",
                  sources: { onchain: 1, market: 2, primary: 1, news: 0, social: 1 },
                  verdict: "WEAKENED",
                  reason: "A deep pool and a thesis the skeptic weakened but did not reject.",
                },
              ],
              leaving: [{ symbol: "CHOG", currentWeightBps: 500 }],
              portfolioView:
                "Two large tokens plus cash fit a Balanced goal; the account trims WMON back under its weight and adds a first WBTC position.",
              evidenceStrength: "mixed",
              whatWouldChangeIt:
                "WBTC's pool thinning out, or MON's volatility rising past the brake.",
              evaluation: {
                passed: true,
                checkedAt: "2026-10-10T12:00:00.000Z",
                findings: [],
                cost: {
                  legs: 3,
                  turnoverUsdcE6: "15000000",
                  estimatedCostUsdcE6: "30000",
                  costBps: 20,
                },
              },
              createdAt: "2026-10-10T12:00:00.000Z",
              expiresAt: "2026-10-11T12:00:00.000Z",
              decidedAt: null,
            }}
            actions={
              <>
                <Button size="sm">Approve this plan</Button>
                <Button size="sm" variant="secondary">
                  Decline
                </Button>
              </>
            }
          />
          <PlanCard
            view={{
              proposalId: "prop-00000000-0000-4000-8000-000000000002",
              status: "rejected",
              needsApproval: true,
              cashTargetBps: 3_000,
              currentCashBps: 7_000,
              positions: [
                {
                  token: DS_USDC,
                  symbol: "WBTC",
                  targetWeightBps: 4_600,
                  bandBps: 300,
                  currentWeightBps: null,
                  action: "ADD",
                  thesis: null,
                  killCriterion: "The deepest pool's liquidity halves.",
                  recheckAt: "2026-11-01",
                  trimAboveBps: null,
                  confidence: null,
                  sources: { onchain: 0, market: 0, primary: 0, news: 0, social: 2 },
                  verdict: "REJECTED",
                  reason: "",
                },
              ],
              leaving: [],
              portfolioView: "A single large WBTC position.",
              evidenceStrength: "weak",
              whatWouldChangeIt: "An onchain source for the flows.",
              evaluation: {
                passed: false,
                checkedAt: "2026-10-10T12:00:00.000Z",
                findings: [
                  {
                    code: "ENVELOPE_POSITION",
                    message: "WBTC at 46.00% is above the Balanced envelope's 45.00% per position.",
                  },
                  {
                    code: "DEPTH",
                    message:
                      "A 10.00 USDC leg into WBTC would fill 1.20% under the oracle, past the 0.40% hurdle.",
                  },
                ],
                cost: null,
              },
              createdAt: "2026-10-10T10:00:00.000Z",
              expiresAt: null,
              decidedAt: "2026-10-10T10:00:00.000Z",
            }}
          />
        </div>
      </Specimen>
      <Specimen
        name="Why the plan did not change"
        note="The Zoom out's no-change decision: its reason code and plain explanation, with what would change it."
      >
        <NoChangeNotice
          reasonCode="EVIDENCE_THIN"
          explanation="The account sits inside its bands; the only new thesis rests on one source. What would change it: a second, onchain source for the WBTC flows."
          at="2026-10-10T11:00:00.000Z"
        />
      </Specimen>
    </Section>
  );
}

/** F-U10: the activation sweep's specimens, with the clock held at one moment. */
const ACT_NOW = "2026-10-10T20:05:00.000Z";
const actStep = (
  key: string,
  label: string,
  state: ActivationPanelView["steps"][number]["state"],
  over: Partial<ActivationPanelView["steps"][number]> = {},
): ActivationPanelView["steps"][number] => ({
  key,
  label,
  state,
  result: null,
  reason: null,
  chargedUsdcE6: "0",
  ceilingUsdcE6: "0",
  startedAt: null,
  finishedAt: null,
  ...over,
});
const ACT_DONE = [
  actStep("account", "Reading your goal and account", "done", {
    result: "Balanced on the Medium tier; 90.00 USDC to trade with; 12.00 USDC of credits.",
  }),
  actStep("scan", "Scanning the market", "done", {
    result: "3 themes worth a closer look.",
    chargedUsdcE6: "210000",
    ceilingUsdcE6: "500000",
  }),
  actStep("market", "Reading pools and prices", "done", {
    result: "11 of 12 tokens priced across 42 pools; 9 safety screens fresh.",
  }),
];
const ACT_RUNNING: ActivationPanelView = {
  activationId: "act-design-1",
  status: "running",
  tier: { label: "Medium", model: "Claude Sonnet 5.5" },
  ceilingUsdcE6: "3800000",
  chargedUsdcE6: "1110000",
  steps: [
    ...ACT_DONE,
    actStep("dives", "Researching in depth", "running", {
      result: "1 of 2 themes researched.",
      chargedUsdcE6: "900000",
      ceilingUsdcE6: "2400000",
      startedAt: "2026-10-10T20:02:35.000Z",
    }),
    actStep("challenge", "Checking risk", "pending"),
    actStep("test", "Testing the plan against your limits", "pending"),
    actStep("plan", "Building a plan", "pending"),
    actStep("active", "Active", "pending"),
  ],
  outcome: {
    title: "Building the first plan",
    message:
      "The agent reads the market, researches the most promising tokens, checks the risks and builds a plan for you to approve. Nothing is traded until you approve it.",
    action: "none",
  },
  startedAt: "2026-10-10T20:00:00.000Z",
  finishedAt: null,
};
const ACT_PLAN_READY: ActivationPanelView = {
  ...ACT_RUNNING,
  activationId: "act-design-2",
  status: "plan_ready",
  chargedUsdcE6: "2660000",
  steps: [
    ...ACT_DONE,
    actStep("dives", "Researching in depth", "done", {
      result: "2 themes researched: WBTC_ADD, CHOG_ADD.",
      chargedUsdcE6: "1900000",
      ceilingUsdcE6: "2400000",
    }),
    actStep("challenge", "Checking risk", "done", {
      result: "1 of 2 theses stand after the skeptic's review.",
      chargedUsdcE6: "150000",
      ceilingUsdcE6: "300000",
    }),
    actStep("test", "Testing the plan against your limits", "done", {
      result: "Your limits and the envelope are set for the plan.",
    }),
    actStep("plan", "Building a plan", "done", {
      result: "A portfolio of 2 positions proposed.",
      chargedUsdcE6: "400000",
      ceilingUsdcE6: "600000",
    }),
    actStep("active", "Active", "running", {
      result: "Waiting for your approval of the plan.",
      startedAt: "2026-10-10T20:04:40.000Z",
    }),
  ],
  outcome: {
    title: "Your approval is needed",
    message:
      "The sweep ended with a plan. Read it below and approve it to turn automatic trading on; decline it and nothing is traded.",
    action: "approve",
  },
  finishedAt: "2026-10-10T20:04:40.000Z",
};
const ACT_ACTIVE: ActivationPanelView = {
  ...ACT_PLAN_READY,
  activationId: "act-design-3",
  status: "active",
  steps: [
    ...ACT_PLAN_READY.steps.slice(0, 7),
    actStep("active", "Active", "done", {
      result: "The plan is approved; the agent trades toward it within your limits.",
    }),
  ],
  outcome: {
    title: "Automatic trading is on",
    message:
      "The agent trades toward its plan within your limits, one capped leg at a time, and keeps researching on its own.",
    action: "none",
  },
};
const ACT_OUT_OF_CREDITS: ActivationPanelView = {
  ...ACT_RUNNING,
  activationId: "act-design-4",
  status: "out_of_credits",
  steps: [
    ...ACT_DONE,
    actStep("dives", "Researching in depth", "failed", {
      result: "1 of 2 themes researched.",
      reason: "the credits ran out",
      chargedUsdcE6: "900000",
      ceilingUsdcE6: "2400000",
    }),
    actStep("challenge", "Checking risk", "skipped"),
    actStep("test", "Testing the plan against your limits", "skipped"),
    actStep("plan", "Building a plan", "skipped"),
    actStep("active", "Active", "skipped"),
  ],
  outcome: {
    title: "The agent ran out of credits",
    message:
      '"Researching in depth" failed: the credits ran out. Nothing was traded; only the steps that ran were charged. Add USDC to the funding address, then try again.',
    action: "add_credits",
  },
  finishedAt: "2026-10-10T20:04:00.000Z",
};
const ACT_CAPPED: ActivationPanelView = {
  ...ACT_RUNNING,
  activationId: "act-design-5",
  status: "capped",
  chargedUsdcE6: "480000",
  steps: [
    ACT_DONE[0] as ActivationPanelView["steps"][number],
    actStep("scan", "Scanning the market", "capped", {
      reason: "the step used all its model turns",
      chargedUsdcE6: "480000",
      ceilingUsdcE6: "500000",
    }),
    actStep("market", "Reading pools and prices", "skipped"),
    actStep("dives", "Researching in depth", "skipped"),
    actStep("challenge", "Checking risk", "skipped"),
    actStep("test", "Testing the plan against your limits", "skipped"),
    actStep("plan", "Building a plan", "skipped"),
    actStep("active", "Active", "skipped"),
  ],
  outcome: {
    title: "The sweep stopped at a limit",
    message:
      '"Scanning the market" stopped: the step used all its model turns. Nothing was traded; only the steps that ran were charged. Try again.',
    action: "retry",
  },
  finishedAt: "2026-10-10T20:01:30.000Z",
};
const ACT_CHECKS_OK = [
  {
    code: "GOAL",
    ok: true,
    message: "Goal: Balanced on the Medium tier (Claude Sonnet 5.5).",
    blocking: true,
  },
  { code: "PROVISIONED", ok: true, message: "The agent is set up to run.", blocking: true },
  {
    code: "ACCOUNT",
    ok: true,
    message: "The trading account is open on the fund agent's set.",
    blocking: true,
  },
  { code: "ACCOUNT_MODE", ok: true, message: "The account is in its normal mode.", blocking: true },
  {
    code: "TRADING_BALANCE",
    ok: true,
    message: "The account holds 90.00 USDC to trade with.",
    blocking: true,
  },
  {
    code: "CREDITS",
    ok: true,
    message: "Credits cover the sweep: 12.00 USDC available, at most 3.80 USDC needed.",
    blocking: true,
  },
  {
    code: "GRANT",
    ok: false,
    message:
      "Your wallet registers the agent's trading permission (30 days at most) when you turn trading on.",
    blocking: false,
  },
  { code: "NOT_BUSY", ok: true, message: "The agent is free to start.", blocking: true },
];
const ACT_CHECKS_BLOCKED = ACT_CHECKS_OK.map((c) =>
  c.code === "CREDITS"
    ? {
        ...c,
        ok: false,
        message:
          "Credits are short: 3.00 USDC available, the sweep may cost up to 3.80 USDC. Add USDC to the funding address first.",
      }
    : c.code === "TRADING_BALANCE"
      ? {
          ...c,
          ok: false,
          message:
            "The account holds 4.00 USDC; automatic trading needs at least 5.00 USDC. Deposit more first.",
        }
      : c,
);

/** F-U10: the activation sweep's panel in every state, the checks before it, the status tag and the 2D pulse. */
function ActivationSection() {
  return (
    <Section id="activation" title="Activation sweep">
      <Specimen
        name="Before the sweep"
        note="The checks the owner sees before turning automatic trading on, each named when it fails, and the sweep's ceiling on the goal's tier; the grant is a step to come, not a block."
      >
        <div className="grid gap-6 lg:grid-cols-2" data-testid="activation-checks-specimens">
          <ActivationChecks checks={ACT_CHECKS_OK} ceilingUsdcE6="3800000" tierLabel="Medium" />
          <ActivationChecks
            checks={ACT_CHECKS_BLOCKED}
            ceilingUsdcE6="3800000"
            tierLabel="Medium"
          />
        </div>
      </Specimen>
      <Specimen
        name="The step panel"
        note="The eight steps with their live states, each step's one-line result and its cost against its ceiling, the sweep's cost against the ceiling shown before it started, and what happened at the end with what the owner can do: running (the clock held still), a plan waiting for approval, active, out of credits, and stopped at a limit."
      >
        <div className="grid gap-6 xl:grid-cols-2" data-testid="activation-panels">
          <ActivationPanel view={ACT_RUNNING} now={ACT_NOW} />
          <ActivationPanel
            view={ACT_PLAN_READY}
            now={ACT_NOW}
            actions={<Button size="sm">Read the plan</Button>}
          />
          <ActivationPanel
            view={ACT_ACTIVE}
            now={ACT_NOW}
            actions={
              <Button size="sm" variant="danger">
                Disarm
              </Button>
            }
          />
          <ActivationPanel
            view={ACT_OUT_OF_CREDITS}
            now={ACT_NOW}
            actions={
              <>
                <Button size="sm">Add credits</Button>
                <Button size="sm" variant="secondary">
                  Try again
                </Button>
              </>
            }
          />
          <ActivationPanel
            view={ACT_CAPPED}
            now={ACT_NOW}
            actions={<Button size="sm">Try again</Button>}
          />
        </div>
      </Specimen>
      <Specimen
        name="Status tag and the 2D pulse"
        note="The sweep's status as the agent viewer's badge, every value; and a species shown in 2D pulses while the sweep runs, since it cannot take off."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2" data-testid="activation-status-tags">
            {ACTIVATION_STATUSES.map((status) => (
              <ActivationStatusTag key={status} status={status} />
            ))}
          </div>
          <div className="grid max-w-md grid-cols-2 gap-4" data-testid="species-pulse-specimen">
            <SpeciesArt image={null} speciesName="Ant" tier="base" slots={3} pulse />
            <SpeciesArt image={null} speciesName="Ant" tier="base" slots={3} />
          </div>
        </div>
      </Specimen>
    </Section>
  );
}

/* F-U11: the portfolio window's pieces, with two days of readings. */
const WIN_E18 = 10n ** 18n;
const winAt = (hours: number) =>
  new Date(Date.parse("2026-10-08T00:00:00.000Z") + hours * 3_600_000).toISOString();
const winRow = (over: Partial<AssetRow> & { symbol: string }): AssetRow => ({
  decimals: 18,
  amountRaw: WIN_E18.toString(),
  isCash: false,
  valueUsdcE6: "10000000",
  shareBps: 1_000,
  costBasisUsdcE6: "9000000",
  gainUsdcE6: "1000000",
  gainBps: 1_111,
  ...over,
});
const WIN_ROWS: AssetRow[] = [
  winRow({
    symbol: "USDC",
    decimals: 6,
    amountRaw: "58400000",
    isCash: true,
    valueUsdcE6: "58400000",
    shareBps: 5_573,
    costBasisUsdcE6: "58400000",
    gainUsdcE6: null,
    gainBps: null,
  }),
  winRow({
    symbol: "WBTC",
    decimals: 8,
    amountRaw: "31000",
    valueUsdcE6: "34100000",
    shareBps: 3_254,
    costBasisUsdcE6: "31000000",
    gainUsdcE6: "3100000",
    gainBps: 1_000,
  }),
  winRow({
    symbol: "WMON",
    amountRaw: (480n * WIN_E18).toString(),
    valueUsdcE6: "12288000",
    shareBps: 1_172,
    costBasisUsdcE6: "13200000",
    gainUsdcE6: "-912000",
    gainBps: -690,
  }),
  winRow({
    symbol: "CHOG",
    amountRaw: (2_000n * WIN_E18).toString(),
    valueUsdcE6: null,
    shareBps: null,
    costBasisUsdcE6: "1500000",
    gainUsdcE6: null,
    gainBps: null,
  }),
];
const WIN_MANY: AssetRow[] = [
  winRow({
    symbol: "USDC",
    decimals: 6,
    amountRaw: "30000000",
    isCash: true,
    valueUsdcE6: "30000000",
    shareBps: 3_000,
    costBasisUsdcE6: "30000000",
    gainUsdcE6: null,
    gainBps: null,
  }),
  ...(["WBTC", "WETH", "WMON", "AUSD", "CHOG", "DAK", "YAKI"] as const).map((symbol, i) =>
    winRow({ symbol, shareBps: 1_600 - i * 200, valueUsdcE6: String(16_000_000 - i * 2_000_000) }),
  ),
];
/** Forty-nine hourly readings: a gentle climb with a dip, no randomness. */
const WIN_SERIES: SeriesPoint[] = Array.from({ length: 49 }, (_, i) => {
  const wave = Math.round(Math.sin(i / 5) * 180 + i * 9 - (i > 30 && i < 38 ? 260 : 0));
  return {
    at: winAt(i),
    perUnitE18: (WIN_E18 + BigInt(wave) * 10n ** 14n).toString(),
    valueUsdcE6: String(100_000_000 + wave * 10_000 + (i >= 20 ? 20_000_000 : 0)),
    reason: i === 7 || i === 22 || i === 40 ? "trade" : "interval",
  };
});
const WIN_MARKS: TradeMarkView[] = [
  {
    at: winAt(7),
    intentId: "i-1",
    side: "buy",
    symbol: "WBTC",
    amountRaw: "31000",
    decimals: 8,
    usdcE6: "31000000",
    txHash: "0xab",
  },
  {
    at: winAt(22),
    intentId: "i-2",
    side: "buy",
    symbol: "WMON",
    amountRaw: (600n * WIN_E18).toString(),
    decimals: 18,
    usdcE6: "16500000",
    txHash: "0xcd",
  },
  {
    at: winAt(40),
    intentId: "i-3",
    side: "sell",
    symbol: "WMON",
    amountRaw: (120n * WIN_E18).toString(),
    decimals: 18,
    usdcE6: "3300000",
    txHash: null,
  },
];
const WIN_WAITING = {
  returnSinceStart: {
    ok: false as const,
    reason: "Not enough data yet: the account needs at least an hour of history.",
  },
  maxDrawdown: {
    ok: false as const,
    reason: "Not enough data yet: the account needs at least an hour of history.",
  },
  winShare: { ok: false as const, reason: "Not enough data yet: no position has been closed." },
};

function WindowSection() {
  return (
    <Section id="window" title="Portfolio window">
      <Specimen
        name="Asset makeup"
        note="Every held token with its amount, value where priced, share of the priced total, cost basis and gain or loss; a token without a usable price stays listed with its share and gain unknown. Stacked on a phone. Beside it, the allocation as a donut: at most six slices and Other, USDC in steel and each token with a colour of its own that follows the token, never its rank."
      >
        <div className="grid gap-6 xl:grid-cols-[1fr_auto]" data-testid="window-makeup">
          <AssetMakeupTable
            rows={WIN_ROWS}
            totalValueUsdcE6="104788000"
            asOf={{ at: winAt(48), live: true }}
          />
          <AllocationDonut rows={WIN_ROWS} />
        </div>
        <div className="grid gap-6 xl:grid-cols-2" data-testid="window-makeup-states">
          <AllocationDonut rows={WIN_MANY} />
          <div className="flex flex-col gap-4">
            <AssetMakeupTable rows={[]} totalValueUsdcE6={null} asOf={null} />
            <AllocationDonut rows={[WIN_ROWS[3] as AssetRow]} />
          </div>
        </div>
      </Specimen>
      <Specimen
        name="Performance"
        note="What $100 put in at the start would be worth, on the account's value per unit, so deposits and withdrawals never count: one line with a faint wash, hairline gridlines, a marker per trade ringed in the surface (a buy points up, a sale down), a crosshair and tooltip on hover, and the readings as a table on request. Under two readings it says so."
      >
        <div className="flex flex-col gap-6" data-testid="window-performance">
          <PerformanceChart series={WIN_SERIES} marks={WIN_MARKS} />
          <PerformanceChart series={WIN_SERIES.slice(0, 1)} marks={[]} />
        </div>
      </Specimen>
      <Specimen
        name="Scores and the $100 figure"
        note="The return since the start, the largest fall from a peak and the share of closed positions that made money, each with a plain note; and $100 at the start beside what holding USDC would have given. Every one says not enough data yet, and why, while the history is too short."
      >
        <div className="flex flex-col gap-6" data-testid="window-scores">
          <ScoreTiles
            scores={{
              returnSinceStart: { ok: true, bps: 412, since: winAt(0), asOf: winAt(48) },
              maxDrawdown: { ok: true, bps: 318, peakAt: winAt(29), troughAt: winAt(33) },
              winShare: { ok: true, bps: 5_000, closed: 2, won: 1 },
            }}
          />
          <div className="grid gap-6 lg:grid-cols-2">
            <HundredDollarTile
              hundred={{ ok: true, now: "104.12", usdc: "100.00", since: winAt(0) }}
            />
            <HundredDollarTile
              hundred={{ ok: true, now: "96.40", usdc: "100.00", since: winAt(0) }}
            />
          </div>
          <ScoreTiles scores={WIN_WAITING} />
          <HundredDollarTile
            hundred={{
              ok: false,
              reason: "Not enough data yet: the account needs at least two readings.",
            }}
          />
        </div>
      </Specimen>
    </Section>
  );
}

const GOAL_HARD = {
  maxTradeBps: 1_000,
  maxPositionBps: 4_000,
  minUsdcShareBps: 1_000,
  maxSlippageBps: 50,
  maxTradesPer24h: 20,
};
const GOAL_COST_ROWS = RESEARCH_INTENSITIES.map((intensity) => ({
  intensity,
  dailyBudgetUsdcE6: RESEARCH_INTENSITY_FACTS[intensity].defaultDailyBudgetUsdcE6,
}));
const usdcText = (e6: bigint) => (Number(e6) / 1e6).toFixed(2);

/** P3-U1: the Goal page's pieces, every state. */
function GoalSection() {
  const [preset, setPreset] = useState<Aggressiveness>("BALANCED");
  const [intensity, setIntensity] = useState<ResearchIntensity>("LIGHT");
  const [limit, setLimit] = useState("");
  return (
    <Section id="goal" title="Goal">
      <Specimen
        name="ChoiceGroup"
        note="One choice among a few, each a card with its numbers. Arrow keys move the choice."
      >
        <ChoiceGroup
          legend="Aggressiveness"
          hint="One choice that produces the brief the agent reads and the envelope the Test enforces."
          value={preset}
          onValueChange={setPreset}
          options={AGGRESSIVENESS_LEVELS.map((id) => {
            const f = AGGRESSIVENESS_FACTS[id];
            return { value: id, title: f.label, description: f.summary };
          })}
        />
        <ChoiceGroup
          legend="Research intensity"
          value={intensity}
          onValueChange={setIntensity}
          options={RESEARCH_INTENSITIES.map((id) => {
            const f = RESEARCH_INTENSITY_FACTS[id];
            return {
              value: id,
              title: f.label,
              ...(id === "LIGHT" ? { note: "Default" } : {}),
              description: `A Scan every ${f.scanEveryHours} hours, up to ${f.divesPerDay} Dive${f.divesPerDay === 1 ? "" : "s"} a day.`,
              detail: `${usdcText(f.defaultDailyBudgetUsdcE6)} USDC a day, at most ${usdcText(f.defaultDailyBudgetUsdcE6 * 30n)} a month`,
            };
          })}
        />
        <ChoiceGroup
          legend="Model tier (the whole group disabled)"
          value="MEDIUM"
          onValueChange={() => undefined}
          disabled
          options={MODEL_TIERS.map((id) => ({
            value: id,
            title: `${MODEL_TIER_FACTS[id].label}: ${MODEL_TIER_FACTS[id].model}`,
            description: MODEL_TIER_FACTS[id].note,
            ...(id === "MEDIUM" ? { note: "Default" } : {}),
          }))}
        />
      </Specimen>
      <Specimen
        name="LimitField"
        note="A stricter limit: empty keeps the hard limit; a value may only tighten it."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <LimitField field="maxTradeBps" hard={1_000} valueText={limit} onChange={setLimit} />
          <LimitField field="maxTradesPer24h" hard={20} valueText="6" onChange={() => undefined} />
          <LimitField
            field="minUsdcShareBps"
            hard={1_000}
            valueText="9"
            onChange={() => undefined}
            error="Least in USDC can only tighten the hard limit of 10%; 9% would loosen it."
          />
          <LimitField
            field="maxSlippageBps"
            hard={50}
            valueText=""
            onChange={() => undefined}
            disabled
          />
        </div>
      </Specimen>
      <Specimen
        name="EffectiveLimits"
        note="The hard limit, the owner's, and the tighter of the two."
      >
        <EffectiveLimits
          hard={GOAL_HARD}
          owner={{
            maxTradeBps: 500,
            maxPositionBps: null,
            minUsdcShareBps: 2_000,
            maxSlippageBps: null,
            maxTradesPer24h: 6,
          }}
          effective={{ ...GOAL_HARD, maxTradeBps: 500, minUsdcShareBps: 2_000, maxTradesPer24h: 6 }}
        />
        <EffectiveLimits
          hard={GOAL_HARD}
          owner={{
            maxTradeBps: 1_200,
            maxPositionBps: null,
            minUsdcShareBps: null,
            maxSlippageBps: null,
            maxTradesPer24h: null,
          }}
          refused={["maxTradeBps"]}
          effective={GOAL_HARD}
        />
      </Specimen>
      <Specimen
        name="CostPreview"
        note="What a month of research can cost at each intensity (D-299), with the chosen one marked."
      >
        <CostPreview rows={GOAL_COST_ROWS} selected="LIGHT" days={30} sweepMaxUsdcE6={4_000_000n} />
      </Specimen>
      <Specimen
        name="GoalSummary"
        note="The goal in one line with the agent's state, for the card and the portfolio."
      >
        <div className="flex flex-col gap-3">
          <GoalSummary state="UNCONFIGURED" aggressiveness={null} />
          <GoalSummary state="READY" aggressiveness="BALANCED" />
          <GoalSummary state="RUNNING" aggressiveness="AGGRESSIVE" />
        </div>
      </Specimen>
      <Specimen
        name="GoalSaveStatus"
        note="The save's result: saving, saved, refused with each reason, failed."
      >
        <div className="flex flex-col gap-3">
          <GoalSaveStatus state="saving" text="Saving the goal." />
          <GoalSaveStatus
            state="saved"
            text="Goal saved. The agent is now Ready, under strategy epoch 1."
          />
          <GoalSaveStatus
            state="refused"
            text="The goal was not saved; fix the fields named below."
            reasons={["Largest trade can only tighten the hard limit of 10%; 12% would loosen it."]}
          />
          <GoalSaveStatus state="failed" text="Could not reach the platform API. Try again." />
        </div>
      </Specimen>
    </Section>
  );
}

/** P3-U2: a market figure as the platform checked it, every state. */
function MarketSection() {
  return (
    <Section id="market" title="Market data">
      <Specimen
        name="SourcedFigure"
        note="A figure with its source, its age and each warning in words; a refused or missing value says so."
      >
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <SourcedFigure
            label="MON price"
            value="0.0241 USD"
            source="coinmarketcap"
            ageText="2 minutes old"
          />
          <SourcedFigure
            label="Monad TVL"
            value="1,006,343,813 USD"
            source="defillama"
            ageText="3 days old"
            warnings={[
              {
                code: "STALE",
                message: "72 hours old, past this source's 48-hour freshness rule.",
              },
            ]}
          />
          <SourcedFigure
            label="MON price"
            value="0.0300 USD"
            source="chainlink"
            ageText="20 seconds old"
            warnings={[
              {
                code: "SOURCES_DISAGREE",
                message:
                  "24.40% away from coinmarketcap's figure, past the 3.00% tolerance; both are shown.",
              },
            ]}
          />
          <SourcedFigure
            label="MON price"
            value={null}
            source="coinmarketcap"
            ageText="1 minute old"
            warnings={[
              {
                code: "REFUSED_OUT_OF_RANGE",
                message:
                  "coinmarketcap gave a value outside the plausible range 0.0001 to 100, so it is not used.",
              },
            ]}
          />
          <SourcedFigure
            label="24h volume"
            value={null}
            source="coinmarketcap"
            ageText="1 minute old"
            warnings={[{ code: "MISSING", message: "coinmarketcap did not give this value." }]}
          />
          <SourcedFigure
            label="30d volatility"
            value="64.2%"
            source="computed"
            ageText="1 hour old"
            warnings={[
              {
                code: "THIN_HISTORY",
                message: "Computed from 90 returns; the method asks for at least 160.",
              },
            ]}
          />
        </div>
      </Specimen>
    </Section>
  );
}

/** P3-U4: preformatted operator text, as the console shows a stage's raw notes and briefs. */
function ResearchSection() {
  return (
    <Section id="research" title="Research records">
      <Specimen
        name="CodeBlock"
        note="Preformatted text for operators: long lines wrap, and a tall block scrolls inside a focusable region."
      >
        <div className="grid gap-6 lg:grid-cols-2" data-testid="code-blocks">
          <CodeBlock label="Raw notes (platform-only)">
            {`CHANGED: Monad TVL fell 6.8% over seven days (DefiLlama).
THEMES: TVL_OUTFLOW high, MON_VOL_SPIKE medium.
QUIET: no.`}
          </CodeBlock>
          <CodeBlock label="THEME brief (accepted)">
            {JSON.stringify(
              {
                kind: "THEME",
                themeCode: "TVL_OUTFLOW",
                thesis: {
                  statement: "Lending keeps its share while DEX TVL falls.",
                  killCriterion: "Lending TVL falls below 412 million USD.",
                  horizonHours: 72,
                  confidence: "low",
                },
              },
              null,
              2,
            )}
          </CodeBlock>
        </div>
      </Specimen>
    </Section>
  );
}

const TERM_LINES: readonly TerminalLineView[] = [
  {
    seq: 1,
    at: "2026-10-11T12:00:01.000Z",
    kind: "cycle",
    stage: null,
    text: "Routine research started, reasoning on research-medium.",
    tone: "info",
  },
  {
    seq: 2,
    at: "2026-10-11T12:00:02.000Z",
    kind: "stage",
    stage: "SCAN",
    text: "Scan started on research-medium; it may cost up to 0.5 USDC.",
    tone: "info",
  },
  {
    seq: 3,
    at: "2026-10-11T12:00:03.000Z",
    kind: "tool",
    stage: "SCAN",
    text: 'web_search: searching the web for "monad tvl"',
    tone: "info",
  },
  {
    seq: 4,
    at: "2026-10-11T12:00:04.000Z",
    kind: "tool",
    stage: "SCAN",
    text: "web_search: 5 results from news.example, defillama.com.",
    tone: "ok",
  },
  {
    seq: 5,
    at: "2026-10-11T12:00:10.000Z",
    kind: "brief",
    stage: "SCAN",
    text: "Scan brief: Monad TVL fell 6.8% in 7 days, a large weekly move for the chain.",
    tone: "ok",
  },
  {
    seq: 6,
    at: "2026-10-11T12:00:10.000Z",
    kind: "source",
    stage: "SCAN",
    text: "Sources, news: news.example; source: web_search.",
    tone: "info",
  },
  {
    seq: 7,
    at: "2026-10-11T12:00:20.000Z",
    kind: "cost",
    stage: "SCAN",
    text: "Scan cost 0.19 of at most 0.5 USDC, over 3 model calls.",
    tone: "info",
  },
  {
    seq: 8,
    at: "2026-10-11T12:00:22.000Z",
    kind: "tool",
    stage: "DIVE",
    text: "x_search: refused (run_cap).",
    tone: "warn",
  },
  {
    seq: 9,
    at: "2026-10-11T12:00:30.000Z",
    kind: "thesis",
    stage: "DIVE",
    text: "Thesis (medium confidence): The outflow is a rotation into lending, not an exit. It fails if lending TVL falls with DEX TVL for 3 days.",
    tone: "ok",
  },
  {
    seq: 10,
    at: "2026-10-11T12:00:31.000Z",
    kind: "objection",
    stage: "CHALLENGE",
    text: "Objection 1 (high): The lending figure has one source.",
    tone: "warn",
  },
  {
    seq: 11,
    at: "2026-10-11T12:00:40.000Z",
    kind: "withheld",
    stage: "ZOOM_OUT",
    text: "[a line was withheld: it carried playbook text]",
    tone: "warn",
  },
  {
    seq: 12,
    at: "2026-10-11T12:00:44.000Z",
    kind: "check",
    stage: "TEST",
    text: "Test checks: the plan failed 1 check: position cap.",
    tone: "warn",
  },
];
const RESEARCH_NOW = "2026-10-11T12:05:00.000Z";
const RESEARCH_SCHEDULE = {
  running: true,
  schedulingOn: true,
  paused: false,
  fastCadence: false,
  intensity: "STANDARD",
  nextDueAt: "2026-10-11T15:00:00.000Z",
  lastScanAt: "2026-10-11T09:00:00.000Z",
  lastZoomOutAt: "2026-10-10T12:30:00.000Z",
  lastOverviewAt: "2026-10-05T12:30:00.000Z",
  waitingReason: null,
  waitingSince: null,
  scanEveryMs: 6 * 3_600_000,
  zoomOutEveryMs: 24 * 3_600_000,
  overviewEveryMs: 7 * 24 * 3_600_000,
  triggerSpacingMs: 2 * 3_600_000,
  refreshesOverview: true,
};

function ResearchLoopSection() {
  return (
    <Section id="research-loop" title="Research loop">
      <Specimen
        name="AgentTerminal"
        note="A live, monospace feed of what the agent is doing, one plain line per event: stage starts and ends with the cost against the ceiling, tool calls and their results as counts and domains, briefs, theses, objections, checks and decisions. Lines the owner may not see are withheld and say so. Every state: connecting, live, ended, reconnecting from the last line, and nothing yet."
      >
        <div className="grid gap-6 xl:grid-cols-2" data-testid="agent-terminals">
          <AgentTerminal
            lines={TERM_LINES}
            state="live"
            cycle={{ kind: "ROUTINE", status: "running" }}
          />
          <AgentTerminal
            lines={TERM_LINES.slice(0, 7)}
            state="reconnecting"
            cycle={{ kind: "ROUTINE", status: "running" }}
          />
          <AgentTerminal
            lines={TERM_LINES}
            state="ended"
            cycle={{ kind: "ROUTINE", status: "completed" }}
          />
          <AgentTerminal lines={[]} state="idle" />
        </div>
        <p className="text-xs text-foreground-muted">States: {TERMINAL_STATES.join(", ")}.</p>
      </Specimen>
      <Specimen
        name="ResearchScheduleCard and BudgetMeter"
        note="The cadence from the goal's intensity, the next due time, the last work, why the loop waits, paused, not running, and the loop off; the day's budget with the Dives used."
      >
        <div className="grid gap-6 lg:grid-cols-2" data-testid="research-schedules">
          <ResearchScheduleCard
            view={RESEARCH_SCHEDULE}
            now={RESEARCH_NOW}
            actions={
              <Button size="sm" variant="secondary">
                Pause research
              </Button>
            }
          />
          <ResearchScheduleCard
            view={{
              ...RESEARCH_SCHEDULE,
              waitingReason: "BUDGET_SHORT",
              waitingSince: "2026-10-11T10:00:00.000Z",
            }}
            now={RESEARCH_NOW}
          />
          <ResearchScheduleCard
            view={{ ...RESEARCH_SCHEDULE, paused: true }}
            now={RESEARCH_NOW}
            actions={<Button size="sm">Resume research</Button>}
          />
          <ResearchScheduleCard
            view={{ ...RESEARCH_SCHEDULE, running: false }}
            now={RESEARCH_NOW}
          />
          <ResearchScheduleCard
            view={{ ...RESEARCH_SCHEDULE, schedulingOn: false, fastCadence: true }}
            now={RESEARCH_NOW}
          />
          <BudgetMeter usedUsdcE6="1410000" dailyUsdcE6="3800000" divesToday={1} divesPerDay={2} />
        </div>
      </Specimen>
      <Specimen
        name="TriggerList and StageTimeline"
        note="The triggers the watcher fired, each answered by a cycle, queued or waiting its turn; the cycles with their stages' cost against the ceiling, one selectable."
      >
        <div className="grid gap-6 lg:grid-cols-2" data-testid="research-timeline">
          <TriggerList
            now={RESEARCH_NOW}
            triggers={[
              {
                triggerId: "t1",
                code: "PRICE_MOVE",
                text: "MON's price moved past the goal's trigger since the last Zoom out",
                kind: "TRIGGERED",
                firedAt: "2026-10-11T11:00:00.000Z",
                cycleId: "cycle-1",
                spaced: false,
              },
              {
                triggerId: "t2",
                code: "MODE_CHANGED",
                text: "the account's mode changed",
                kind: "REVIEW",
                firedAt: "2026-10-11T11:30:00.000Z",
                cycleId: null,
                spaced: true,
              },
              {
                triggerId: "t3",
                code: "THESIS_RECHECK",
                text: "a thesis reached its recheck time",
                kind: "TRIGGERED",
                firedAt: "2026-10-11T11:50:00.000Z",
                cycleId: null,
                spaced: false,
              },
            ]}
          />
          <StageTimeline
            selected="cycle-2"
            onSelect={() => undefined}
            cycles={[
              {
                cycleId: "cycle-2",
                kind: "REVIEW",
                status: "running",
                startedAt: "2026-10-11T11:40:00.000Z",
                finishedAt: null,
                chargedUsdcE6: "0",
                stages: [
                  {
                    stage: "TEST",
                    themeCode: null,
                    status: "completed",
                    chargedUsdcE6: "0",
                    ceilingUsdcE6: "0",
                  },
                  {
                    stage: "ZOOM_OUT",
                    themeCode: null,
                    status: "running",
                    chargedUsdcE6: "0",
                    ceilingUsdcE6: "600000",
                  },
                ],
              },
              {
                cycleId: "cycle-1",
                kind: "ROUTINE",
                status: "completed",
                startedAt: "2026-10-11T06:00:00.000Z",
                finishedAt: "2026-10-11T06:05:00.000Z",
                chargedUsdcE6: "410000",
                stages: [
                  {
                    stage: "SCAN",
                    themeCode: null,
                    status: "completed",
                    chargedUsdcE6: "190000",
                    ceilingUsdcE6: "500000",
                  },
                  {
                    stage: "DIVE",
                    themeCode: "TVL_OUTFLOW",
                    status: "capped",
                    chargedUsdcE6: "220000",
                    ceilingUsdcE6: "1200000",
                  },
                  {
                    stage: "CHALLENGE",
                    themeCode: "TVL_OUTFLOW",
                    status: "completed",
                    chargedUsdcE6: "80000",
                    ceilingUsdcE6: "300000",
                  },
                  {
                    stage: "TEST",
                    themeCode: null,
                    status: "completed",
                    chargedUsdcE6: "0",
                    ceilingUsdcE6: "0",
                  },
                  {
                    stage: "ZOOM_OUT",
                    themeCode: null,
                    status: "skipped",
                    chargedUsdcE6: "0",
                    ceilingUsdcE6: "600000",
                  },
                ],
              },
            ]}
          />
        </div>
      </Specimen>
      <Specimen
        name="ResearchOverview, ThemesPanel, MarketSnapshotPanel and PlanUnchangedCard"
        note="The records around the terminal, filled and empty: the market overview with its sourced points, the last Scan's themes, the watcher's snapshot of the market and the account, and why the last review kept the plan."
      >
        <div className="grid gap-6 lg:grid-cols-2" data-testid="research-records">
          <ResearchOverview
            overview={{
              at: "2026-10-11T06:05:00.000Z",
              summary:
                "Monad's DEX liquidity is thinning while lending holds its share; MON's price has drifted with the wider market.",
              points: [
                {
                  text: "Lending protocols hold 412 million USD.",
                  class: "onchain",
                  sources: ["defillama.com"],
                },
                {
                  text: "DEX TVL fell 6.8% over 7 days.",
                  class: "news",
                  sources: ["news.example"],
                },
              ],
            }}
          />
          <ThemesPanel
            themes={{
              at: "2026-10-11T06:01:00.000Z",
              summary: "Monad TVL fell 6.8% in 7 days, a large weekly move for the chain.",
              quiet: false,
              themes: [
                {
                  code: "TVL_OUTFLOW",
                  materiality: "high",
                  scope: "MARKET",
                  symbol: null,
                  whyNow: "A 6.8% weekly fall is large for the chain.",
                },
                {
                  code: "WMON_CORE_ALLOCATION",
                  materiality: "medium",
                  scope: "TOKEN",
                  symbol: "WMON",
                  whyNow: "The core token's share of the account against its range.",
                },
              ],
            }}
          />
          <MarketSnapshotPanel
            snapshot={{
              at: "2026-10-11T12:04:00.000Z",
              monUsd: "0.03",
              volatilityPct: 110,
              mode: "NORMAL",
              navUsdcE6: "41600000",
              held: [
                {
                  symbol: "WMON",
                  priceUsd: "0.03",
                  liquidityUsd: 1_250_000,
                  screen: "passed",
                  status: "listed",
                },
                {
                  symbol: "WBTC",
                  priceUsd: "61240",
                  liquidityUsd: 310_000,
                  screen: "passed",
                  status: "sell_only",
                },
              ],
            }}
          />
          <PlanUnchangedCard
            view={{
              at: "2026-10-11T06:05:00.000Z",
              reasonCode: "EVIDENCE_THIN",
              portfolioView:
                "One position in WMON and the rest in USDC; the lending thesis rests on one source.",
              whatWouldChangeIt: "a second source for the lending figure",
            }}
          />
          <ResearchOverview overview={null} />
          <ThemesPanel themes={null} />
          <MarketSnapshotPanel snapshot={null} />
          <PlanUnchangedCard view={null} />
        </div>
      </Specimen>
    </Section>
  );
}

const SENTINEL_ACTIONS = [
  {
    actionId: "s1",
    code: "DRAWDOWN_12",
    text: "the account fell 12% or more from its 7-day peak",
    action: "REDUCE_ONLY",
    state: null,
    reason: "12.5% below the 7-day peak",
    txHash: "0xa1",
    status: "done" as const,
    at: "2026-10-11T12:30:00.000Z",
  },
  {
    actionId: "s2",
    code: "STALE_FEED",
    text: "a held token's price feed is stale or unusable",
    action: "REDUCE_ONLY",
    state: "INCIDENT",
    reason: "WBTC: 4000 s old",
    txHash: null,
    status: "skipped" as const,
    at: "2026-10-11T12:45:00.000Z",
  },
  {
    actionId: "s3",
    code: "STALE_FEED",
    text: "a held token's price feed is stale or unusable",
    action: "INCIDENT",
    state: "INCIDENT",
    reason: "agent state RUNNING to INCIDENT",
    txHash: null,
    status: "done" as const,
    at: "2026-10-11T12:45:00.000Z",
  },
  {
    actionId: "s4",
    code: "ZERO_CREDITS",
    text: "the agent has no credits left",
    action: "NOTE",
    state: null,
    reason: "the condition cleared; the account's mode stays until its owner reviews it",
    txHash: null,
    status: "done" as const,
    at: "2026-10-11T13:00:00.000Z",
  },
];

function SentinelSection() {
  return (
    <Section id="sentinel" title="Risk sentinel">
      <Specimen
        name="SentinelCard"
        note="What the sentinel watches and every action it took with its reason: nothing wrong, conditions in force with the account tightened, and a stack without the sentinel."
      >
        <div className="grid gap-6 lg:grid-cols-2" data-testid="sentinel-cards">
          <SentinelCard
            view={{
              configured: true,
              active: {},
              lastCheckedAt: "2026-10-11T13:05:00.000Z",
              actions: [],
              mode: "NORMAL",
            }}
          />
          <SentinelCard
            view={{
              configured: true,
              active: {
                STALE_FEED: "2026-10-11T12:45:00.000Z",
                DRAWDOWN_12: "2026-10-11T12:30:00.000Z",
              },
              lastCheckedAt: "2026-10-11T13:05:00.000Z",
              actions: SENTINEL_ACTIONS,
              mode: "REDUCE_ONLY",
            }}
            actions={
              <Button size="sm" variant="secondary">
                Open the portfolio
              </Button>
            }
          />
          <SentinelCard
            view={{ configured: false, active: {}, lastCheckedAt: null, actions: [], mode: null }}
          />
        </div>
      </Specimen>
    </Section>
  );
}

function DesignSystem() {
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Design system</h1>
        <p className="max-w-dialog text-sm text-foreground-muted">
          Every token and component, in every state. Pages are built only from these (the frontend
          rule in CLAUDE.md).
        </p>
      </header>
      <TokensSection />
      <ActionsSection />
      <LabelsSection />
      <WalletSection />
      <AgentSection />
      <PortfolioSection />
      <ActivationSection />
      <WindowSection />
      <FormsSection />
      <OverlaysSection />
      <DataSection />
      <GoalSection />
      <MarketSection />
      <ResearchSection />
      <ResearchLoopSection />
      <SentinelSection />
    </div>
  );
}

export { DesignSystem };
