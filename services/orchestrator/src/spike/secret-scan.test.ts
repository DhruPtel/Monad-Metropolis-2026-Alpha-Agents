import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoSecrets, scanForSecrets } from "./secret-scan.ts";

const VK = "sk-virtual-0123456789abcdef";
const GATE = "gate-secret-0123456789abcdef";

describe("scanForSecrets", () => {
  it("names each secret and file it finds, never the value", () => {
    const dir = mkdtempSync(join(tmpdir(), "scan-"));
    mkdirSync(join(dir, "home/.hermes"), { recursive: true });
    writeFileSync(join(dir, "home/.hermes/.env"), `AGENT_LLM_KEY=${VK}\n`);
    writeFileSync(
      join(dir, "proc-dump.txt"),
      Buffer.concat([Buffer.from("X=1\0"), Buffer.from(GATE)]),
    );
    writeFileSync(join(dir, "clean.txt"), "nothing here");
    const hits = scanForSecrets(dir, { virtualKey: VK, gateSecret: GATE });
    expect(hits).toEqual(
      expect.arrayContaining([
        { secret: "virtualKey", file: "home/.hermes/.env" },
        { secret: "gateSecret", file: "proc-dump.txt" },
      ]),
    );
    expect(hits).toHaveLength(2);
    expect(JSON.stringify(hits)).not.toContain(VK);
  });

  it("finds nothing in a clean tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "scan-"));
    writeFileSync(join(dir, "a.txt"), "AGENT_LLM_KEY=injected-outside-the-sandbox");
    expect(scanForSecrets(dir, { virtualKey: VK })).toEqual([]);
  });

  it("refuses to scan for a short value", () => {
    expect(() => scanForSecrets(tmpdir(), { tiny: "abc" })).toThrow(/too short/);
  });
});

describe("assertNoSecrets", () => {
  it("throws when a report would contain a secret", () => {
    expect(() => assertNoSecrets(`{"key":"${VK}"}`, { virtualKey: VK })).toThrow(/virtualKey/);
    expect(() => assertNoSecrets(`{"ok":true}`, { virtualKey: VK })).not.toThrow();
  });
});
