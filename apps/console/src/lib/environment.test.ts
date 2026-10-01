import { describe, expect, it } from "vitest";
import { configView } from "./environment";

// What the environment panel renders from config must never hold a secret value.
const SECRET_RPC = "https://rpc.provider.test/v1/LEAKCHECK-mainnet-key";

describe("environment panel config", () => {
  it("shows a set secret only as set (redacted)", () => {
    const view = configView({
      MONAD_RPC_URL: SECRET_RPC,
      DATABASE_URL: "postgres://u:LEAKCHECK-pw@db.test:5432/db",
    });
    expect(view.ok && view.summary.variables.MONAD_RPC_URL).toBe("set (redacted)");
    const rendered = JSON.stringify(view);
    expect(rendered).not.toContain("LEAKCHECK");
    expect(rendered).not.toContain("rpc.provider.test");
  });

  it("shows an invalid secret by name and problem only", () => {
    const view = configView({ DATABASE_URL: "not a url LEAKCHECK" });
    expect(view.ok).toBe(false);
    expect(JSON.stringify(view)).not.toContain("LEAKCHECK");
    expect(!view.ok && view.issues[0]?.variable).toBe("DATABASE_URL");
  });
});
