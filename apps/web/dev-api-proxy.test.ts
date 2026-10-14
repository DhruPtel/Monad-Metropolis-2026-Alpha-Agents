import { describe, expect, it } from "vitest";
import { devApiProxy } from "./dev-api-proxy";

const DEV = "phase-development-server";
const env = { WEB_DEV_API_PROXY: "1", CONTROL_API_URL: "http://127.0.0.1:4100/" };

describe("the dev-only control API proxy (UI-FAST)", () => {
  it("forwards /dev-api to the control API under next dev when asked", () => {
    expect(devApiProxy(DEV, env)).toEqual({
      browserPath: "/dev-api",
      rewrites: [{ source: "/dev-api/:path*", destination: "http://127.0.0.1:4100/:path*" }],
    });
  });

  it.each(["phase-production-build", "phase-production-server"])("is never part of %s", (phase) => {
    expect(devApiProxy(phase, env)).toEqual({ browserPath: "", rewrites: [] });
  });

  it("is off under next dev unless the flag is 1", () => {
    for (const flag of [undefined, "", "0", "true"])
      expect(devApiProxy(DEV, { ...env, WEB_DEV_API_PROXY: flag }).browserPath).toBe("");
  });
});

describe("the hosted build's same-origin API path (2026-10-14)", () => {
  const hosted = { WEB_API_PROXY: "1", CONTROL_API_URL: "https://api.example.test/" };

  it.each(["phase-production-build", "phase-production-server", DEV])(
    "gives the browser /api in %s when asked, forwarded by the route, not a rewrite",
    (phase) => {
      expect(devApiProxy(phase, hosted)).toEqual({ browserPath: "/api", rewrites: [] });
    },
  );

  it("is off unless the flag is 1", () => {
    for (const flag of [undefined, "", "0", "true"])
      expect(
        devApiProxy("phase-production-build", { ...hosted, WEB_API_PROXY: flag }).browserPath,
      ).toBe("");
  });
});
