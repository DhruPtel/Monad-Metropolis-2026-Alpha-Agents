import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SkillEditor } from "./skill-editor";

const TEMPLATES = [
  { id: "notes", name: "Owner notes", description: "Notes the agent reads before every Scan." },
  { id: "watchlist", name: "Watchlist", description: "Tokens the agent must look at." },
];
const FILES = [
  { path: "skill.json", content: '{\n  "id": "my-notes"\n}\n' },
  { path: "SKILL.md", content: "# My notes\n" },
];

describe("SkillEditor (BC-U1)", () => {
  it("offers the templates, edits each file and saves only once the check passed", async () => {
    const onTemplate = vi.fn();
    const onChange = vi.fn();
    const onSave = vi.fn();
    const { rerender } = render(
      <SkillEditor
        templates={TEMPLATES}
        templateId="notes"
        onTemplate={onTemplate}
        files={FILES}
        onChange={onChange}
        check={{ state: "checking" }}
        findings={[]}
        onSave={onSave}
      />,
    );
    expect(screen.getByRole("button", { name: /Owner notes/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: /Watchlist/ }));
    expect(onTemplate).toHaveBeenCalledWith("watchlist");
    await userEvent.type(screen.getByLabelText("SKILL.md"), "!");
    expect(onChange).toHaveBeenCalledWith("SKILL.md", "# My notes\n!");
    expect(screen.getByRole("status")).toHaveTextContent("Checking against every rule");
    expect(screen.getByRole("button", { name: "Save and mount" })).toBeDisabled();

    rerender(
      <SkillEditor
        templates={TEMPLATES}
        templateId="notes"
        onTemplate={onTemplate}
        files={FILES}
        onChange={onChange}
        check={{ state: "passed", skillId: "my-notes", warnings: 1 }}
        findings={[
          {
            rule: "S13",
            severity: "warn",
            path: "references/notes.md:3",
            message: "an address not in the book",
            means: "It may be an impostor.",
            next: "Use the registered address.",
          },
        ]}
        onSave={onSave}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "my-notes passes every check, with 1 warning worth a look",
    );
    expect(screen.getByTestId("skill-findings")).toHaveAttribute("data-blocked", "false");
    await userEvent.click(screen.getByRole("button", { name: "Save and mount" }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("names the blocking findings and keeps the save closed", () => {
    render(
      <SkillEditor
        templates={TEMPLATES}
        templateId="notes"
        onTemplate={() => undefined}
        files={FILES}
        onChange={() => undefined}
        check={{ state: "refused", blocking: 2 }}
        findings={[
          {
            rule: "S1",
            severity: "block",
            path: "SKILL.md:4",
            message: "shell or code execution",
            means: "A skill is text, never code.",
            next: "Remove the command.",
          },
        ]}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("2 findings block the package");
    expect(screen.getByTestId("skill-findings")).toHaveAttribute("data-blocked", "true");
    expect(screen.getByRole("button", { name: "Save and mount" })).toBeDisabled();
  });
});
