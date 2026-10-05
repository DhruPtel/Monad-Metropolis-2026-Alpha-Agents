import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentCard } from "./agent-card";
import { MINT_STATES, MintButton } from "./mint-button";
import { SLOT_STATES, SlotHex } from "./slot-hex";
import { SpeciesArt, slotPositionsOnArt } from "./species-art";
import { ViewerFrame } from "./viewer-frame";

const TBA = "0x6148e658098A14df34Cc79dB6b4128Dc367C7d3E";
const OWNER = "0x960f4063b0242aD076978759f3A52c0140300891";

describe("SlotHex", () => {
  it.each(SLOT_STATES)("labels the %s state for screen readers", (state) => {
    render(<SlotHex index={2} state={state} skillName="Momentum scanner" />);
    const slot = screen.getByRole("img");
    expect(slot).toHaveAttribute("data-state", state);
    expect(slot).toHaveAccessibleName(
      state === "filled" ? "Slot 3: Momentum scanner" : "Slot 3: empty",
    );
  });
});

describe("SpeciesArt", () => {
  it("shows the species image when there is one", () => {
    render(<SpeciesArt image="/species/bee.webp" speciesName="Bee" tier="pro" />);
    expect(screen.getByRole("img", { name: "Bee agent" })).toHaveAttribute(
      "src",
      "/species/bee.webp",
    );
  });

  it("shows a tier placeholder when the species has no art", () => {
    render(<SpeciesArt image={null} speciesName="Firefly" tier="medium" />);
    const art = screen.getByRole("img", { name: "Firefly agent" });
    expect(art).toHaveTextContent("Medium · Firefly");
    expect(art).toHaveTextContent("Art coming soon");
  });

  it("shows the unrevealed placeholder before reveal", () => {
    render(<SpeciesArt image={null} speciesName={null} tier={null} />);
    expect(screen.getByRole("img", { name: "Unrevealed agent" })).toHaveTextContent("Unrevealed");
  });

  it.each([3, 5, 8])("puts %i slots on the art", (n) => {
    render(<SpeciesArt image={null} speciesName="Ant" tier="base" slots={n} />);
    const list = screen.getByRole("list", { name: "Skill slots" });
    expect(within(list).getAllByRole("img", { name: /^Slot \d: empty$/ })).toHaveLength(n);
  });

  it("spreads slots round the art, slot 1 at the top centre, all inside it", () => {
    const positions = slotPositionsOnArt(8);
    expect(positions[0]).toEqual({ left: "50.00%", top: "10.00%" });
    for (const p of positions) {
      for (const v of [p.left, p.top]) {
        const n = Number.parseFloat(v);
        expect(n).toBeGreaterThanOrEqual(10);
        expect(n).toBeLessThanOrEqual(90);
      }
    }
  });
});

describe("ViewerFrame", () => {
  it("names the region and renders its badge, tools, overlay and readouts", () => {
    render(
      <ViewerFrame
        label="Agent viewer"
        badge={<span>badge</span>}
        tools={<span>tools</span>}
        overlay={<span>overlay</span>}
        readoutLeft="Pro · Bee"
        readoutRight="slots 0/8"
      >
        <span>content</span>
      </ViewerFrame>,
    );
    const frame = screen.getByRole("region", { name: "Agent viewer" });
    for (const text of ["badge", "tools", "overlay", "content", "Pro · Bee", "slots 0/8"]) {
      expect(within(frame).getByText(text)).toBeInTheDocument();
    }
  });
});

describe("MintButton", () => {
  it.each(MINT_STATES)("renders the %s state", (state) => {
    render(
      <MintButton state={state} agentId={7n} revealedAs="Pro · Bee" onMint={() => undefined} />,
    );
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("is busy and disabled while claiming, signing or minting", () => {
    for (const state of ["claiming", "signing", "minting"] as const) {
      const { unmount } = render(<MintButton state={state} onMint={() => undefined} />);
      const button = screen.getByRole("button");
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-busy", "true");
      unmount();
    }
  });

  it("says Rejected in wallet when the user rejects the signature, and can mint again", async () => {
    const onMint = vi.fn();
    render(<MintButton state="rejected" onMint={onMint} />);
    expect(screen.getByRole("status")).toHaveTextContent("Rejected in wallet");
    await userEvent.click(screen.getByRole("button", { name: "Mint an agent" }));
    expect(onMint).toHaveBeenCalledOnce();
  });

  it("explains a refused claim and offers no retry that would do nothing", () => {
    render(
      <MintButton
        state="claim-refused"
        message="This wallet has already minted an agent"
        onMint={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Mint unavailable" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("This wallet has already minted an agent");
  });

  it("names the agent while waiting for reveal and once revealed", () => {
    const { rerender } = render(<MintButton state="awaiting-reveal" agentId={7n} />);
    expect(screen.getByRole("status")).toHaveTextContent("Agent #7 minted");
    rerender(<MintButton state="revealed" agentId={7n} revealedAs="Pro · Bee" />);
    expect(screen.getByRole("status")).toHaveTextContent("Agent #7 is Pro · Bee");
  });

  it("disables the button without a mint action", () => {
    render(<MintButton state="idle" />);
    expect(screen.getByRole("button", { name: "Mint an agent" })).toBeDisabled();
  });
});

describe("AgentCard", () => {
  it("shows a revealed agent's token, tier, species, slots and addresses", () => {
    render(
      <AgentCard
        agentId={14n}
        tier="pro"
        speciesName="Bee"
        image="/species/bee.webp"
        slots={8}
        tba={TBA}
        owner={OWNER}
        ownerEpoch={2n}
        environment="local fork"
      />,
    );
    expect(screen.getByRole("heading", { name: "Alpha Agent #14" })).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("Bee")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("local fork")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /token-bound account of agent 14/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /owner of agent 14/i })).toBeInTheDocument();
  });

  it("says unrevealed for the tier and species before reveal", () => {
    render(
      <AgentCard
        agentId={15n}
        tier={null}
        speciesName={null}
        image={null}
        slots={0}
        tba={TBA}
        owner={OWNER}
        ownerEpoch={0n}
        environment="local fork"
      />,
    );
    expect(screen.getAllByText("Unrevealed").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("after reveal")).toBeInTheDocument();
  });
});
