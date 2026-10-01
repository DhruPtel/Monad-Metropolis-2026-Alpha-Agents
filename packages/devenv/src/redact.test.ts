import { describe, expect, it } from "vitest";
import { redact } from "./redact.ts";

describe("redact", () => {
  it("removes the full URL", () => {
    const url = "https://rpc.provider.test/v1/abcdef123456";
    expect(redact(`Endpoint: ${url}`, [url])).toBe("Endpoint: <redacted>");
  });

  it("removes a key carried in the subdomain", () => {
    const url = "https://key9876.provider.test/";
    const out = redact("request to key9876.provider.test failed", [url]);
    expect(out).not.toContain("key9876");
  });

  it("removes a key that appears without the rest of the URL", () => {
    const url = "https://rpc.provider.test/v1/abcdef123456";
    expect(redact("path /v1/abcdef123456 refused", [url])).not.toContain("abcdef123456");
  });

  it("removes query parameter values", () => {
    const url = "https://rpc.provider.test/?apikey=secretvalue";
    expect(redact("apikey=secretvalue", [url])).not.toContain("secretvalue");
  });

  it("leaves text alone when no secret is set", () => {
    expect(redact("Listening on 127.0.0.1:8545", [undefined, ""])).toBe(
      "Listening on 127.0.0.1:8545",
    );
  });
});
