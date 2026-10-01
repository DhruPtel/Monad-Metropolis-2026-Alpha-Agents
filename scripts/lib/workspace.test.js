// @ts-check
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./paths.js";

// The root `pnpm typecheck` runs `pnpm -r typecheck`, which silently skips a
// package without the script, so every workspace package must declare one.
const packageDirs = ["packages", "apps", "services", "chains"].flatMap((group) =>
  readdirSync(join(ROOT, group), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, group, d.name, "package.json")))
    .map((d) => join(group, d.name)),
);

describe("workspace packages", () => {
  it("include the shared packages", () => {
    expect(packageDirs).toEqual(
      expect.arrayContaining([
        "packages/config",
        "packages/domain",
        "packages/policy",
        "packages/skills",
        "packages/workflows",
        "packages/accounting",
      ]),
    );
  });

  it.each(packageDirs)("%s has a typecheck script and a tsconfig", (dir) => {
    const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
    expect(pkg.scripts?.typecheck).toBe("tsc --noEmit -p .");
    expect(existsSync(join(ROOT, dir, "tsconfig.json"))).toBe(true);
  });
});

describe("CI workflow", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const uses = ci.split("\n").filter((line) => /^\s*(-\s*)?uses:/.test(line));

  it("pins every action to a full commit SHA with its version tag in a comment", () => {
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line.trim()).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
  });
});

describe("Playwright image", () => {
  it("is the same pinned image locally and in CI, matching @playwright/test", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const local = readFileSync(join(ROOT, "scripts/web-e2e.js"), "utf8");
    const pin = /mcr\.microsoft\.com\/playwright:v([\d.]+)-noble@sha256:[0-9a-f]{64}/;
    const ciImage = ci.match(pin);
    const localImage = local.match(pin);
    expect(ciImage?.[0]).toBeDefined();
    expect(ciImage?.[0]).toBe(localImage?.[0]);
    const web = JSON.parse(readFileSync(join(ROOT, "apps/web/package.json"), "utf8"));
    expect(web.devDependencies["@playwright/test"]).toBe(ciImage?.[1]);
  });
});
