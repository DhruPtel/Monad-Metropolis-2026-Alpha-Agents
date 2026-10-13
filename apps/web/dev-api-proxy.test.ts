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
