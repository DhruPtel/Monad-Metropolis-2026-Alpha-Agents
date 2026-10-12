import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OwnerSkillsEmpty, SkillFindings, SkillGrid, SkillTile, SkillUploadForm } from "./skills";

const BUILTIN = {
  id: "monad-assets-basics",
  name: "Monad assets basics",
  version: "1.0.2",
  description: "What MON, WMON and USDC are on Monad. Use when a token is unfamiliar.",
  kind: "skill" as const,
  contentHash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
  tools: ["data.web_search@1"],
};

describe("the skills tiles, findings and upload form (SK-U1)", () => {
  it("shows a built-in skill and the owner's own skill as tiles, the owner's marked and dated", () => {
    render(
      <SkillGrid>
        <SkillTile skill={BUILTIN} />
        <SkillTile
          skill={{
            ...BUILTIN,
            id: "owner-notes",
            name: "Owner notes on Monad",
            kind: "owner",
            uploadedAt: "2026-10-12 07:40 UTC",
            warnings: 1,
          }}
          actions={<button type="button">Remove</button>}
        />
      </SkillGrid>,
    );
    const tiles = screen.getAllByTestId("skill-tile");
    expect(tiles.map((t) => t.getAttribute("data-kind"))).toEqual(["skill", "owner"]);
    expect(tiles[0]?.textContent).toContain("Built in");
    expect(tiles[0]?.textContent).toContain("a1b2c3d4e5f6");
    expect(tiles[0]?.textContent).toContain("1 declared");
    const own = tiles[1] as HTMLElement;
    expect(own.textContent).toContain("Yours");
    expect(own.textContent).toContain("2026-10-12 07:40 UTC");
    expect(within(own).getByTestId("skill-warnings").textContent).toContain(
      "1 warning from the audit",
    );
    expect(within(own).getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("lists findings with the rule, the file, what it means and what to do, blocking ones marked", () => {
    render(
      <SkillFindings
        blocked
        findings={[
          {
            rule: "S1",
            severity: "block",
            path: "SKILL.md:12",
            message: "shell or code execution",
            means: "The text asks for shell or code to run.",
            next: "Remove shell blocks and commands.",
          },
          {
            rule: "S13",
            severity: "warn",
            path: "references/notes.md:3",
            message: "0x1111… is not in the platform address book",
            means: "An address in the text is not in the address book.",
            next: "Use registered addresses.",
          },
        ]}
      />,
    );
    const section = screen.getByTestId("skill-findings");
    expect(section.getAttribute("data-blocked")).toBe("true");
    expect(section.textContent).toContain("The package was refused");
    const items = screen.getAllByTestId("skill-finding");
    expect(items.map((i) => i.getAttribute("data-rule"))).toEqual(["S1", "S13"]);
    expect(items[0]?.textContent).toContain("Blocks");
    expect(items[0]?.textContent).toContain("SKILL.md:12");
    expect(items[0]?.textContent).toContain("Next: Remove shell blocks");
    expect(items[1]?.textContent).toContain("Warning");
  });

  it("says a package with warnings alone is mounted, and renders nothing without findings", () => {
    const { unmount } = render(
      <SkillFindings
        blocked={false}
        findings={[
          {
            rule: "S5",
            severity: "warn",
            path: "SKILL.md:4",
            message: "a network endpoint",
            means: "m",
            next: "n",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("skill-findings").textContent).toContain(
      "passed with warnings, and is mounted",
    );
    unmount();
    render(<SkillFindings blocked={false} findings={[]} />);
    expect(screen.queryByTestId("skill-findings")).toBeNull();
  });

  it("takes one folder input, lists what was picked, and uploads only with skill.json and SKILL.md present", () => {
    const events: string[] = [];
    const { rerender } = render(
      <SkillUploadForm
        files={[]}
        onPick={() => events.push("pick")}
        onUpload={() => events.push("upload")}
        onClear={() => events.push("clear")}
      />,
    );
    expect(screen.getByTestId("skill-upload")).toBeDisabled();
    fireEvent.change(screen.getByTestId("skill-folder-input"));
    expect(events).toEqual(["pick"]);
    rerender(
      <SkillUploadForm
        files={[{ path: "SKILL.md", bytes: 1200 }]}
        onPick={() => events.push("pick")}
        onUpload={() => events.push("upload")}
        onClear={() => events.push("clear")}
      />,
    );
    expect(screen.getByTestId("chosen-files-missing").textContent).toContain(
      "skill.json is missing",
    );
    expect(screen.getByTestId("skill-upload")).toBeDisabled();
    rerender(
      <SkillUploadForm
        files={[
          { path: "skill.json", bytes: 400 },
          { path: "SKILL.md", bytes: 1200 },
        ]}
        onPick={() => events.push("pick")}
        onUpload={() => events.push("upload")}
        onClear={() => events.push("clear")}
      />,
    );
    expect(screen.getByTestId("chosen-files").textContent).toContain("2 files, 1.6 KB");
    fireEvent.click(screen.getByTestId("skill-upload"));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(events).toEqual(["pick", "upload", "clear"]);
  });

  it("explains what an upload is in the empty state, with the button that starts one", () => {
    let clicks = 0;
    render(<OwnerSkillsEmpty onUpload={() => (clicks += 1)} />);
    expect(screen.getByTestId("owner-skills-empty").textContent).toContain(
      "never shown to anyone else",
    );
    fireEvent.click(screen.getByTestId("upload-skill"));
    expect(clicks).toBe(1);
  });
});
