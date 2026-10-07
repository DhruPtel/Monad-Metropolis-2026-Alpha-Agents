import {
  ACCOUNT_MODES,
  AGENT_STATES,
  DISPLAY_FLAGS,
  REJECTION_CODES,
  REJECTION_MESSAGES,
} from "@alpha-agents/domain";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Eye } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { AddressDisplay } from "./address-display";
import { AmountDisplay } from "./amount-display";
import { BetaBanner } from "./beta-banner";
import { DemandCounter } from "./demand-counter";
import { ReasonMessage } from "./reason-message";
import { RISK_LEVELS, RiskBadge } from "./risk-badge";
import { StatBar } from "./stat-bar";
import {
  ACCOUNT_MODE_RENDERING,
  AGENT_STATE_RENDERING,
  DISPLAY_FLAG_RENDERING,
  StatusPill,
} from "./status-pill";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";
import { SectionLabel } from "./ui/section-label";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Tag } from "./ui/tag";
import { WALLET_STATES, WalletButton, WalletNotice, WrongChainPrompt } from "./wallet-status";

describe("StatusPill renders every canonical value from packages/domain", () => {
  it("has a rendering for every account mode, agent state and display flag, and nothing else", () => {
    expect(Object.keys(ACCOUNT_MODE_RENDERING).sort()).toEqual([...ACCOUNT_MODES].sort());
    expect(Object.keys(AGENT_STATE_RENDERING).sort()).toEqual([...AGENT_STATES].sort());
    expect(Object.keys(DISPLAY_FLAG_RENDERING).sort()).toEqual([...DISPLAY_FLAGS].sort());
  });

  it.each(ACCOUNT_MODES)("account mode %s", (mode) => {
    render(<StatusPill kind="account_mode" value={mode} />);
    expect(screen.getByText(ACCOUNT_MODE_RENDERING[mode].label)).toBeInTheDocument();
  });

  it.each(AGENT_STATES)("agent state %s", (state) => {
    render(<StatusPill kind="agent_state" value={state} />);
    expect(screen.getByText(AGENT_STATE_RENDERING[state].label)).toBeInTheDocument();
  });

  it.each(DISPLAY_FLAGS)("display flag %s", (flag) => {
    render(<StatusPill kind="display_flag" value={flag} />);
    expect(screen.getByText(DISPLAY_FLAG_RENDERING[flag].label)).toBeInTheDocument();
  });
});

describe("ReasonMessage renders every reason code from packages/domain", () => {
  it.each(REJECTION_CODES)("%s shows its owner-facing message and the code", (code) => {
    render(<ReasonMessage code={code} detail="detail line" />);
    expect(screen.getByText(REJECTION_MESSAGES[code])).toBeInTheDocument();
    expect(screen.getByText(`${code} · detail line`)).toBeInTheDocument();
  });

  it("covers the P0-U6 handover code", () => {
    expect(REJECTION_CODES).toContain("VAULT_IN_HANDOVER");
  });
});

describe("Button", () => {
  it("calls onClick when enabled", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Deploy build</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Deploy build" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("blocks clicks and reports busy while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Deploy build
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Deploy build" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders a link with button styles through asChild", () => {
    render(
      <Button asChild variant="secondary">
        <a href="/design">Open</a>
      </Button>,
    );
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("data-slot", "button");
  });
});

describe("Button sizes and the secondary-accent variant", () => {
  it.each([
    ["sm", "h-7"],
    ["md", "h-9"],
    ["lg", "h-10"],
    ["icon", "size-9"],
  ] as const)("size %s is %s (28, 36 and 40px, D-154)", (size, height) => {
    render(<Button size={size}>Run</Button>);
    expect(screen.getByRole("button", { name: "Run" })).toHaveClass(height);
  });

  it("secondary-accent is a lime outline on a transparent fill", () => {
    render(<Button variant="secondary-accent">Run agent test</Button>);
    expect(screen.getByRole("button", { name: "Run agent test" })).toHaveClass(
      "border-primary-muted",
      "bg-transparent",
      "text-primary",
    );
  });
});

describe("Tag", () => {
  it.each([
    ["neutral", "text-foreground-muted"],
    ["rare", "text-rare"],
    ["legendary", "text-detail"],
    ["accent", "text-primary"],
    ["warning", "text-warning"],
  ] as const)("tone %s uses %s", (tone, textClass) => {
    render(<Tag tone={tone}>Label</Tag>);
    expect(screen.getByText("Label")).toHaveClass(textClass, "rounded-xs");
  });
});

describe("Tabs", () => {
  it("keeps every label on one line and lets the list scroll on narrow screens", () => {
    render(
      <Tabs defaultValue="local">
        <TabsList aria-label="Environment">
          <TabsTrigger value="local">local (fork)</TabsTrigger>
          <TabsTrigger value="beta">beta (mainnet-beta)</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    // The scrolling wrapper is focusable and labelled (D-223, L-90); the list itself is not the scroller.
    const scroller = screen.getByRole("group", { name: "Environment, scrolls sideways" });
    expect(scroller).toHaveClass("overflow-x-auto", "max-w-full");
    expect(scroller.getAttribute("tabindex")).toBe("0");
    expect(scroller).toContainElement(screen.getByRole("tablist"));
    for (const tab of screen.getAllByRole("tab")) expect(tab).toHaveClass("whitespace-nowrap");
  });
});

describe("WalletButton", () => {
  const ADDRESS = "0x2FE5ccb0d7Ea195FEb87987d3573F9fcCE2b5D57";

  it.each(WALLET_STATES)("renders the %s state", (state) => {
    const { container } = render(
      <WalletButton state={state} address={ADDRESS} chainName="Monad" errorMessage="Rejected" />,
    );
    expect(container.querySelector("[data-slot=wallet-button]")).toHaveAttribute(
      "data-state",
      state,
    );
  });

  it("connects from the logged-out state", async () => {
    const onConnect = vi.fn();
    render(<WalletButton state="logged-out" onConnect={onConnect} />);
    await userEvent.click(screen.getByRole("button", { name: /connect/i }));
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("shows the address and chain when connected, and disconnects", async () => {
    const onDisconnect = vi.fn();
    render(
      <WalletButton
        state="connected"
        address={ADDRESS}
        chainName="Monad"
        onDisconnect={onDisconnect}
      />,
    );
    expect(screen.getByText("0x2FE5…5D57")).toBeInTheDocument();
    expect(screen.getByText("Monad")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("is busy and not clickable while connecting", () => {
    render(<WalletButton state="connecting" />);
    expect(screen.getByRole("button", { name: /connecting/i })).toBeDisabled();
  });

  it("offers Cancel while connecting when the connect can be given up", async () => {
    const onCancel = vi.fn();
    render(<WalletButton state="connecting" onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("names the connected wallet beside its address", () => {
    render(<WalletButton state="connected" address={ADDRESS} walletName="OKX Wallet" />);
    expect(screen.getByText("OKX Wallet")).toBeInTheDocument();
    expect(screen.getByText("0x2FE5…5D57")).toBeInTheDocument();
  });

  it("offers a network switch on the wrong chain and a retry on error", async () => {
    const onSwitchChain = vi.fn();
    const { unmount } = render(<WalletButton state="wrong-chain" onSwitchChain={onSwitchChain} />);
    await userEvent.click(screen.getByRole("button", { name: "Switch network" }));
    expect(onSwitchChain).toHaveBeenCalledOnce();
    unmount();
    const onConnect = vi.fn();
    render(<WalletButton state="error" errorMessage="Rejected" onConnect={onConnect} />);
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onConnect).toHaveBeenCalledOnce();
  });
});

describe("WalletButton when login cannot be retried", () => {
  it("says login is unavailable, explains why, and offers no dead retry button", () => {
    render(
      <WalletButton
        state="error"
        errorLabel="Login unavailable"
        errorMessage="Wallet login is not configured."
      />,
    );
    expect(screen.getByText("Login unavailable")).toBeVisible();
    expect(screen.getByText(/Wallet login is not configured/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });
});

describe("WalletNotice", () => {
  it("is a status that says what the connect waits for, with its actions", () => {
    render(
      <WalletNotice title="Connecting your wallet" actions={<Button>Cancel</Button>}>
        Waiting for MetaMask to answer.
      </WalletNotice>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for MetaMask to answer.");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});

describe("WrongChainPrompt", () => {
  it("is an alert that names both chains and switches", async () => {
    const onSwitchChain = vi.fn();
    render(
      <WrongChainPrompt
        targetChainName="Monad"
        currentChainName="Ethereum"
        onSwitchChain={onSwitchChain}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your wallet is on Ethereum. Nothing can continue until it is on Monad.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Switch to Monad" }));
    expect(onSwitchChain).toHaveBeenCalledOnce();
  });

  it("blocks a second request while the wallet is switching", () => {
    render(<WrongChainPrompt targetChainName="Monad" switching />);
    expect(screen.getByRole("button", { name: "Switch to Monad" })).toBeDisabled();
  });
});

describe("SectionLabel", () => {
  it("is a heading at the chosen level", () => {
    render(<SectionLabel as="h2">Equipped</SectionLabel>);
    const heading = screen.getByRole("heading", { level: 2, name: "Equipped" });
    expect(heading).toHaveClass("uppercase", "tracking-label", "font-mono");
  });

  it("defaults to h3", () => {
    render(<SectionLabel>What this agent does</SectionLabel>);
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("What this agent does");
  });
});

describe("Field", () => {
  it("labels the control and marks an error for screen readers", () => {
    render(
      <Field label="Daily loss limit" error="Must be at most 10%">
        {(c) => <Input {...c} />}
      </Field>,
    );
    const input = screen.getByLabelText("Daily loss limit");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Must be at most 10%");
  });
});

describe("AmountDisplay", () => {
  it("formats a bigint with the domain helper and the symbol", () => {
    render(
      <AmountDisplay value={12_480_000_000n} decimals={6} minFractionDigits={2} symbol="USDC" />,
    );
    expect(screen.getByText("12,480.00")).toBeInTheDocument();
    expect(screen.getByText("USDC")).toBeInTheDocument();
  });

  it("colors a loss red and a gain lime only when asked", () => {
    const { container, rerender } = render(
      <AmountDisplay value={-1_000_000n} decimals={6} colorBySign />,
    );
    expect(container.firstChild).toHaveClass("text-negative");
    rerender(<AmountDisplay value={1_000_000n} decimals={6} colorBySign signed />);
    expect(container.firstChild).toHaveClass("text-positive");
    expect(screen.getByText("+1")).toBeInTheDocument();
    rerender(<AmountDisplay value={-1_000_000n} decimals={6} />);
    expect(container.firstChild).not.toHaveClass("text-negative");
  });
});

describe("AddressDisplay", () => {
  const address = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";

  it("shortens the address and copies the full one", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(<AddressDisplay address={address} label="Agent wallet" />);
    expect(screen.getByText("0x7547…b603")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy agent wallet" }));
    expect(writeText).toHaveBeenCalledWith(address);
    expect(screen.getByRole("button", { name: "Agent wallet copied" })).toBeInTheDocument();
  });
});

describe("other components", () => {
  it("StatBar exposes its value as a meter", () => {
    render(
      <StatBar
        label="Win rate"
        value="58%"
        fillBps={5_800}
        delta={{ direction: "positive", text: "4%" }}
      />,
    );
    const meter = screen.getByRole("meter", { name: "Win rate" });
    expect(meter).toHaveAttribute("aria-valuenow", "5800");
    expect(meter).toHaveAttribute("aria-valuetext", "58%");
  });

  it("StatBar clamps the fill", () => {
    render(<StatBar label="Risk" value="120%" fillBps={12_000} />);
    expect(screen.getByRole("meter", { name: "Risk" })).toHaveAttribute("aria-valuenow", "10000");
  });

  it.each(RISK_LEVELS)("RiskBadge renders %s", (level) => {
    render(<RiskBadge level={level} />);
    expect(screen.getByText(level.charAt(0).toUpperCase() + level.slice(1))).toBeInTheDocument();
  });

  it.each([
    [3, "+3"],
    [-2, "-2"],
    [0, "0"],
  ])("DemandCounter shows a daily change of %i as %s", (change, text) => {
    render(<DemandCounter icon={Eye} label="Watchers" count={1_204} dailyChange={change} />);
    expect(screen.getByText("1,204")).toBeInTheDocument();
    expect(screen.getByLabelText(`${text} today`)).toBeInTheDocument();
  });

  it("BetaBanner says unaudited beta and names the environment", () => {
    render(<BetaBanner environment="fork" />);
    expect(screen.getByRole("note")).toHaveTextContent(/Unaudited beta\..*Environment: fork/);
  });
});
