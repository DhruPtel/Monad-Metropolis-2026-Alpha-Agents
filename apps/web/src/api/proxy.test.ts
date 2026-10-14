import { describe, expect, it } from "vitest";
import {
  CLIENT_IP_HEADER,
  PROXY_SECRET_HEADER,
  callerIp,
  forwardHeaders,
  forwardToApi,
} from "./proxy";

const ENV = {
  WEB_API_PROXY: "1",
  CONTROL_API_URL: "https://api.example.test/",
  PROXY_SHARED_SECRET: "s3cret-for-tests",
};

describe("the hosted site's API proxy (2026-10-14)", () => {
  it("takes the caller's IP from Vercel's header first, then x-forwarded-for", () => {
    expect(
      callerIp(new Headers({ "x-vercel-forwarded-for": "1.2.3.4", "x-forwarded-for": "9.9.9.9" })),
    ).toBe("1.2.3.4");
    expect(callerIp(new Headers({ "x-forwarded-for": "5.6.7.8, 10.0.0.1" }))).toBe("5.6.7.8");
    expect(callerIp(new Headers({ "x-forwarded-for": "not an ip" }))).toBeNull();
  });

  it("adds the caller's IP and the secret, and never passes the caller's own copies on", () => {
    const h = forwardHeaders(
      new Headers({
        "x-vercel-forwarded-for": "1.2.3.4",
        [CLIENT_IP_HEADER]: "6.6.6.6",
        [PROXY_SECRET_HEADER]: "guess",
        "x-forwarded-for": "7.7.7.7",
        "x-owner-session": "abc",
        host: "vivarium-testnet.vercel.app",
      }),
      ENV.PROXY_SHARED_SECRET,
    );
    expect(h.get(CLIENT_IP_HEADER)).toBe("1.2.3.4");
    expect(h.get(PROXY_SECRET_HEADER)).toBe(ENV.PROXY_SHARED_SECRET);
    expect(h.get("x-owner-session")).toBe("abc");
    expect(h.get("x-forwarded-for")).toBeNull();
    expect(h.get("host")).toBeNull();
  });

  it("adds neither header without a secret", () => {
    const h = forwardHeaders(new Headers({ "x-vercel-forwarded-for": "1.2.3.4" }), undefined);
    expect(h.get(CLIENT_IP_HEADER)).toBeNull();
    expect(h.get(PROXY_SECRET_HEADER)).toBeNull();
  });

  it("forwards the path, query, method and body to the API and passes its answer back", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const send = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response('{"ok":true}', {
        status: 201,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      });
    }) as typeof fetch;
    const res = await forwardToApi(
      new Request("https://site.test/api/v1/agents/4/session?x=1", {
        method: "POST",
        body: "{}",
        headers: { "x-vercel-forwarded-for": "1.2.3.4" },
      }),
      ENV,
      send,
    );
    expect(seen[0]?.url).toBe("https://api.example.test/v1/agents/4/session?x=1");
    expect(seen[0]?.init.method).toBe("POST");
    expect(res?.status).toBe(201);
    expect(res?.headers.get("content-encoding")).toBeNull();
    expect(await res?.json()).toEqual({ ok: true });
  });

  it("is off unless WEB_API_PROXY is 1, and answers 502 when the API is down", async () => {
    const req = new Request("https://site.test/api/health");
    expect(await forwardToApi(req, { ...ENV, WEB_API_PROXY: "" })).toBeNull();
    const down = (async () => {
      throw new Error("refused");
    }) as typeof fetch;
    expect((await forwardToApi(req, ENV, down))?.status).toBe(502);
  });
});
