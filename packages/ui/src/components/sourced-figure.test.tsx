import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourcedFigure } from "./sourced-figure";

describe("SourcedFigure (P3-U2)", () => {
  it("shows the value with its source and age", () => {
    render(
      <SourcedFigure
        label="MON price"
        value="0.0241 USD"
        source="coinmarketcap"
        ageText="2 minutes old"
      />,
    );
    const f = screen.getByTestId("sourced-figure");
    expect(f).toHaveTextContent("MON price");
    expect(f).toHaveTextContent("0.0241 USD");
    expect(f).toHaveTextContent("CoinMarketCap · 2 minutes old");
    expect(within(f).queryByRole("list")).toBeNull();
  });

  it("says a refused value is refused, never shows a number, and lists each warning in words", () => {
    render(
      <SourcedFigure
        label="MON price"
        value={null}
        source="chainlink"
        ageText="now"
        warnings={[
          { code: "REFUSED_OUT_OF_RANGE", message: "Outside the plausible range." },
          { code: "STALE", message: "Old." },
        ]}
      />,
    );
    const f = screen.getByTestId("sourced-figure");
    expect(f).toHaveTextContent("Refused");
    const list = within(f).getByRole("list", { name: "MON price warnings" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["RefusedOutside the plausible range.", "StaleOld."]);
  });

  it("says a missing value is not available", () => {
    render(
      <SourcedFigure
        label="Volume"
        value={null}
        source="coinmarketcap"
        ageText="now"
        warnings={[{ code: "MISSING", message: "Not given." }]}
      />,
    );
    expect(screen.getByTestId("sourced-figure")).toHaveTextContent("Not available");
  });
});
