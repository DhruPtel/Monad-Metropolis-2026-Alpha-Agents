// @ts-check
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVICES, availableMemory, heavyRunning, labelLines } from "./dev-all.js";

describe("pnpm dev:all (D-211)", () => {
  it("starts every service the unit names, in an order where each one's inputs are up", () => {
    expect(SERVICES.map((s) => s.name)).toEqual([
      "indexer",
      "api",
      "orchestrator",
      "web",
      "console",
    ]);
  });

  it("labels each complete line and keeps the unfinished tail for the next chunk", () => {
    const first = labelLines("api", "", "listening\r\nhalf a li");
    expect(first.lines).toEqual(["api          | listening"]);
    const second = labelLines("api", first.rest, "ne\n");
    expect(second).toEqual({ lines: ["api          | half a line"], rest: "" });
  });

  it("sees a heavy suite running, and nothing when only dev servers run", () => {
    expect(
      heavyRunning(
        "node node_modules/@playwright/test/cli.js test\nnode .../next/dist/bin/next build\n",
        "",
      ),
    ).toEqual(["Playwright", "a next build"]);
    expect(
      heavyRunning(
        "",
        "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff1\npostgres:16.15-alpine3.24\n",
      ),
    ).toEqual(["a Playwright container"]);
    expect(
      heavyRunning(
        "node .../next/dist/bin/next dev --port 3000\nanvil --fork-url monad\n",
        "redis:7",
      ),
    ).toEqual([]);
  });

  it("reads available memory, and gives up quietly where it cannot", () => {
    const dir = mkdtempSync(join(tmpdir(), "aa-meminfo-"));
    const file = join(dir, "meminfo");
    writeFileSync(file, "MemTotal:  6000000 kB\nMemAvailable:    2097152 kB\n");
    expect(availableMemory(file)).toBe(2 * 1024 ** 3);
    expect(availableMemory(join(dir, "missing"))).toBeNull();
  });
});
