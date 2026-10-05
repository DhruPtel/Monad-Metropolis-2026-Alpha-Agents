import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MINT_PANEL_STATES, MintPanel, type MintPanelAgent } from "./mint-panel";
import { SpeciesArt } from "./species-art";
import { TierCard, type TierCardSpecies } from "./tier-card";

const PRO_SPECIES: TierCardSpecies[] = [
  { name: "Bee", image: "/species/bee.webp", total: 1, remaining: 0 },
  { name: "Praying mantis", image: null, total: 1, remaining: 1 },
  { name: "Dragonfly", image: null, total: 12, remaining: 11 },
];

describe("TierCard", () => {
  it("shows the tier, its slots, supply, remaining and odds", () => {
    render(
      <TierCard
        tier="pro"
        slots={8}
        total="100"
        remaining="98"
        remainingBps={9800}
        odds="9.8%"
        species={PRO_SPECIES}
      />,
    );
    const card = screen.getByRole("region", { name: "Pro tier" });
    expect(card).toHaveTextContent("8 skill slots");
    expect(card).toHaveTextContent("9.8%");
    expect(within(card).getByRole("meter", { name: "Remaining of 100" })).toHaveAttribute(
      "aria-valuetext",
      "98 of 100",
    );
    expect(card).not.toHaveTextContent("Sold out");
  });

  it("marks one-of-ones and says whether each is drawn", () => {
    render(
      <TierCard
        tier="pro"
        slots={8}
        total="100"
        remaining="98"
        remainingBps={9800}
        odds="9.8%"
        species={PRO_SPECIES}
      />,
    );
    const list = screen.getByRole("list", { name: "Pro species" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Bee1 of 1Drawn");
    expect(rows[1]).toHaveTextContent("Praying mantis1 of 1Not drawn yet");
    expect(rows[2]).toHaveTextContent("Dragonfly11 of 12 left");
    expect(rows.map((r) => r.hasAttribute("data-one-of-one"))).toEqual([true, true, false]);
    expect(within(rows[2] as HTMLElement).queryByText("1 of 1")).toBeNull();
  });

  it("says when the tier is sold out", () => {
    render(
      <TierCard
        tier="medium"
        slots={5}
        total="300"
        remaining="0"
        remainingBps={0}
        odds="0%"
        soldOut
        species={[{ name: "Moth", image: null, total: 38, remaining: 0 }]}
      />,
    );
    const card = screen.getByRole("region", { name: "Medium tier" });
    expect(card).toHaveTextContent("Sold out");
    expect(card).toHaveTextContent("0%");
    expect(card).toHaveTextContent("0 of 38 left");
  });

  it("shows placeholders, not numbers, while loading", () => {
    const { container } = render(
      <TierCard
        tier="base"
        slots={3}
        total="600"
        remaining={null}
        remainingBps={0}
        odds={null}
        species={[{ name: "Ant", image: null, total: 120, remaining: null }]}
      />,
    );
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByTestId("tier-odds")).toBeNull();
    expect(container.querySelectorAll("[data-slot=skeleton]")).toHaveLength(3);
  });
});

describe("SpeciesArt compact", () => {
  it("is decorative: the name beside it says what it is", () => {
    const { container } = render(
      <SpeciesArt compact image="/species/bee.webp" speciesName="Bee" tier="pro" />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("[data-compact]")).toHaveAttribute("aria-hidden", "true");
  });

  it("draws the placeholder without words", () => {
    const { container } = render(<SpeciesArt compact image={null} speciesName="Ant" tier="base" />);
    expect(container).not.toHaveTextContent("Ant");
    expect(container).not.toHaveTextContent("Art coming soon");
  });
});

const PENDING: MintPanelAgent = { id: 7n, tier: null, speciesName: null, image: null };
const REVEALED: MintPanelAgent = { id: 7n, tier: "pro", speciesName: "Bee", image: null };

describe("MintPanel", () => {
  it.each(MINT_PANEL_STATES)("renders the %s state", (state) => {
    render(
      <MintPanel
        state={state}
        mint={{ state: "idle", onMint: () => undefined }}
        agent={state === "revealed" ? REVEALED : PENDING}
        agentHref="/configure?agent=7"
        message="AgentNFT is not deployed on Monad Testnet yet."
        targetNetwork="Monad (local fork)"
        walletNetwork="Ethereum"
        maxSupply="1,000"
        onConnect={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(document.querySelector("[data-slot=mint-panel]")).toHaveAttribute("data-state", state);
    expect(screen.getByRole("heading", { name: "Your mint" })).toBeInTheDocument();
  });

  it("logged out offers the connect button", async () => {
    const onConnect = vi.fn();
    render(<MintPanel state="logged-out" onConnect={onConnect} />);
    expect(screen.getByText("Connect your wallet to mint")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("wrong network names both networks and offers no mint", () => {
    render(
      <MintPanel
        state="wrong-network"
        targetNetwork="Monad (local fork)"
        walletNetwork="Ethereum"
      />,
    );
    expect(screen.getByText("Switch to Monad (local fork) to mint")).toBeInTheDocument();
    expect(screen.getByText(/Your wallet is on Ethereum/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("ready shows the terms and the mint button", async () => {
    const onMint = vi.fn();
    render(<MintPanel state="ready" mint={{ state: "idle", onMint }} />);
    expect(screen.getByText(/Free to mint: you pay only gas. One agent per wallet./)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Mint an agent" }));
    expect(onMint).toHaveBeenCalledOnce();
  });

  it("ready passes a refused claim through to the mint button", () => {
    render(
      <MintPanel
        state="ready"
        mint={{ state: "claim-refused", message: "This wallet is not on the allowlist." }}
      />,
    );
    expect(screen.getByRole("button", { name: "Mint unavailable" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("This wallet is not on the allowlist.");
  });

  it("already minted shows the wallet's agent and its link, and no mint button", () => {
    render(<MintPanel state="already-minted" agent={REVEALED} agentHref="/configure?agent=7" />);
    expect(screen.getByText("This wallet has minted its agent")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open agent #7" })).toHaveAttribute(
      "href",
      "/configure?agent=7",
    );
    expect(screen.queryByRole("button", { name: /Mint/ })).toBeNull();
  });

  it("sold out says so with the cap and offers no mint", () => {
    render(<MintPanel state="sold-out" maxSupply="1,000" />);
    expect(screen.getByText(/All 1,000 agents are minted/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("awaiting reveal shows the pending agent, its placeholder and the link", () => {
    render(
      <MintPanel
        state="awaiting-reveal"
        mint={{ state: "awaiting-reveal", agentId: 7n }}
        agent={PENDING}
        agentHref="/configure?agent=7"
        revealNote="Reveal it with pnpm agent-nft:local reveal."
      />,
    );
    expect(screen.getByRole("img", { name: "Unrevealed agent" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Agent #7 minted");
    expect(screen.getByText(/Waiting for reveal: its tier/)).toBeInTheDocument();
    expect(screen.getByText("Reveal it with pnpm agent-nft:local reveal.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open agent #7" })).toBeInTheDocument();
  });

  it("revealed shows the tier and species", () => {
    render(
      <MintPanel
        state="revealed"
        mint={{ state: "revealed", agentId: 7n, revealedAs: "Pro · Bee" }}
        agent={REVEALED}
        agentHref="/configure?agent=7"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Agent #7 is Pro · Bee");
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("Bee")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Bee agent" })).toBeInTheDocument();
  });

  it("a read error offers a retry", async () => {
    const onRetry = vi.fn();
    render(<MintPanel state="read-error" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("not eligible says why, before any click, and offers no mint", () => {
    render(
      <MintPanel state="not-eligible" message="This wallet is not on the beta mint allowlist." />,
    );
    expect(screen.getByText("This wallet cannot mint")).toBeInTheDocument();
    expect(screen.getByText(/not on the beta mint allowlist/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the agent link with the app's link component", () => {
    const AppLink = ({ href, children }: { href: string; children?: React.ReactNode }) => (
      <a href={href} data-app-link="">
        {children}
      </a>
    );
    render(
      <MintPanel
        state="already-minted"
        agent={REVEALED}
        agentHref="/configure?agent=7"
        linkAs={AppLink}
      />,
    );
    expect(screen.getByRole("link", { name: "Open agent #7" })).toHaveAttribute("data-app-link");
  });
});
