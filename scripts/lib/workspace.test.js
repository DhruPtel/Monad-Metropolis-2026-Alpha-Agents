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
