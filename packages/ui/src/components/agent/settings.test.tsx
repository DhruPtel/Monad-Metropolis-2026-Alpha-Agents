import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataKeyCard, DataKeyForm, DataKeyGrid } from "./settings";

const DUNE = {
  provider: "dune",
  label: "Dune",
  gives: "The dune_query tool on your Dune plan.",
  keyHelp: "Create an API key in your Dune account settings and paste it here.",
  tool: "dune_query",
  present: false,
  hint: null,
  addedAt: null,
};

describe("the owner's data keys (BK-U1)", () => {
  it("shows a source without a key and one with a key by its last characters, never the key", () => {
    render(
      <DataKeyGrid>
        <DataKeyCard source={DUNE} actions={<button type="button">Add key</button>} />
        <DataKeyCard
          source={{ ...DUNE, present: true, hint: "••••mnop", addedAt: "2026-10-12 09:00 UTC" }}
          actions={<button type="button">Remove key</button>}
        />
      </DataKeyGrid>,
    );
    const cards = screen.getAllByTestId("data-key-card");
    expect(cards.map((c) => c.getAttribute("data-present"))).toEqual(["false", "true"]);
    expect(cards[0]?.textContent).toContain("No key");
    expect(cards[0]?.textContent).toContain("answers that it is not configured");
    expect(cards[1]?.textContent).toContain("Your key");
    expect(screen.getByTestId("data-key-hint").textContent).toBe("••••mnop");
    expect(cards[1]?.textContent).toContain("2026-10-12 09:00 UTC");
    expect(cards[1]?.textContent).toContain("never shown again");
  });

  it("takes one password input, names the problem, and saves only once there is a key to save", () => {
    const events: string[] = [];
    const { rerender } = render(
      <DataKeyForm
        source={DUNE}
        value=""
        onChange={(v) => events.push(`change:${v}`)}
        onSave={() => events.push("save")}
        problem={null}
      />,
    );
    const input = screen.getByTestId("data-key-input") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(screen.getByTestId("data-key-save")).toBeDisabled();
    fireEvent.change(input, { target: { value: "abc" } });
    expect(events).toEqual(["change:abc"]);
    rerender(
      <DataKeyForm
        source={DUNE}
        value="abc"
        onChange={() => undefined}
        onSave={() => events.push("save")}
        problem="That is too short for an API key."
      />,
    );
    expect(screen.getByTestId("data-key-form").textContent).toContain("too short");
    fireEvent.submit(screen.getByTestId("data-key-form"));
    expect(events).toEqual(["change:abc"]);
    rerender(
      <DataKeyForm
        source={{ ...DUNE, present: true, hint: "••••mnop" }}
        value="dune-key-not-real-abcdefghijklmnop"
        onChange={() => undefined}
        onSave={() => events.push("save")}
        problem={null}
      />,
    );
    expect(screen.getByTestId("data-key-save").textContent).toBe("Replace key");
    fireEvent.click(screen.getByTestId("data-key-save"));
    expect(events).toEqual(["change:abc", "save"]);
  });
});
