import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LoadoutUnsavedNote, SkillInventoryCards, SkillSlotButtons } from "./skill-loadout";

const skills = [
  { id: "a", name: "Momentum scanner", kind: "skill" as const },
  { id: "b", name: "My filter", kind: "owner" as const },
];

describe("the skill loadout (UI-FAST)", () => {
  it("says which slot a hovered card would take, and where an equipped one sits", () => {
    render(
      <SkillInventoryCards
        skills={skills}
        slotOf={{ b: 0 }}
        nextFreeSlot={1}
        hovered="a"
        onToggle={() => undefined}
        onHover={() => undefined}
      />,
    );
    const [a, b] = screen.getAllByTestId("inventory-skill");
    expect(a).toHaveTextContent("Goes into slot 2");
    expect(b).toHaveTextContent("In slot 1");
    expect(b).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles a card on click and reports hover; a card cannot be added to a full loadout", async () => {
    const onToggle = vi.fn();
    const onHover = vi.fn();
    render(
      <SkillInventoryCards
        skills={skills}
        slotOf={{ b: 0 }}
        nextFreeSlot={null}
        hovered={null}
        onToggle={onToggle}
        onHover={onHover}
      />,
    );
    const [a, b] = screen.getAllByTestId("inventory-skill");
    expect(a).toBeDisabled();
    expect(a).toHaveTextContent("Every slot is full");
    await userEvent.click(b as HTMLElement);
    expect(onToggle).toHaveBeenCalledWith("b");
    expect(onHover).toHaveBeenCalledWith("b");
  });

  it("empties a filled slot on click and lights the hovered target", async () => {
    const onRemove = vi.fn();
    render(
      <SkillSlotButtons
        slots={["Momentum scanner", null, null]}
        highlighted={1}
        onRemove={onRemove}
      />,
    );
    const slots = screen.getAllByTestId("loadout-slot");
    expect(slots[1]).toBeDisabled();
    expect(slots[1]).toHaveTextContent("goes here");
    expect(slots[1]?.querySelector("[data-slot=slot-hex]")).toHaveAttribute(
      "data-state",
      "highlighted",
    );
    await userEvent.click(screen.getByRole("button", { name: /Slot 1: Momentum scanner/ }));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it("says the loadout is not saved", () => {
    render(<LoadoutUnsavedNote />);
    expect(screen.getByTestId("loadout-unsaved")).toHaveTextContent(/not saved.*comes later/);
  });
});
