import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StyleTiles } from "../agent/goal";
import { FlowPills, HeroVisualSlot, HomeHero } from "./home";

describe("the home hero and the style tiles' art (2026-10-13)", () => {
  it("puts the main action under the description and the visual in the reserved spot", () => {
    render(
      <HomeHero
        title="Vivarium"
        lede="Mint an agent."
        stats={[]}
        action={<a href="/mint">Mint an agent</a>}
        below={<FlowPills steps={[{ label: "Deposits", value: "12", active: false }]} />}
        visual={
          <HeroVisualSlot>
            <img src="/brand/vivarium-logo.png" alt="Vivarium" />
          </HeroVisualSlot>
        }
      />,
    );
    expect(screen.getByRole("link", { name: "Mint an agent" })).toHaveAttribute("href", "/mint");
    expect(screen.getByRole("img", { name: "Vivarium" })).toBeInTheDocument();
    expect(screen.getByTestId("flow-pill").querySelector("span")).toHaveClass("text-sm");
  });

  it("shows each style's art in its tile when given", () => {
    render(
      <StyleTiles
        value="BALANCED"
        onValueChange={() => undefined}
        tiles={[
          { value: "BALANCED", title: "Balanced", line: "x", art: "/icons/goal/balanced.png" },
        ]}
      />,
    );
    expect(screen.getByTestId("style-tile").querySelector("img")).toHaveAttribute(
      "src",
      "/icons/goal/balanced.png",
    );
  });
});
