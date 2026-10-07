import { NotLocalForkError } from "@alpha-agents/devenv";
import { describe, expect, it } from "vitest";
import { LOCAL_FEED_REFRESH_MS, localFeedRefresherFor } from "./local-feeds.ts";

describe("the local feed refresher (D-237)", () => {
  it("exists only for the local environment", () => {
    const calls: string[] = [];
    const fake = async (url: string) => calls.push(url);
    expect(localFeedRefresherFor("testnet", "https://testnet-rpc.monad.xyz", fake)).toBeNull();
    expect(localFeedRefresherFor("beta", "https://rpc.monad.xyz", fake)).toBeNull();
    const local = localFeedRefresherFor("local", "http://127.0.0.1:8545", fake);
    expect(local?.everyMs).toBe(LOCAL_FEED_REFRESH_MS);
    expect(calls).toEqual([]);
  });

  it("refreshes the fork it was given, and the real refresher refuses a remote RPC", async () => {
    const calls: string[] = [];
    await localFeedRefresherFor("local", "http://127.0.0.1:8545", async (url) =>
      calls.push(url),
    )?.refresh();
    expect(calls).toEqual(["http://127.0.0.1:8545"]);
    // Even if local were misconfigured with a remote RPC, nothing would be sent there.
    await expect(
      localFeedRefresherFor("local", "https://rpc.monad.xyz")?.refresh(),
    ).rejects.toBeInstanceOf(NotLocalForkError);
  });
});
