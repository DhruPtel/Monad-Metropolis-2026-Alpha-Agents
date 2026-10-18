import { describe, expect, it } from "vitest";
import { DeployerQueue } from "./deployer-queue.ts";

describe("DeployerQueue", () => {
  it("runs sends one at a time, each the spacing after the last one ended, and goes on after a failure", async () => {
    let now = 1_000;
    const slept: number[] = [];
    const q = new DeployerQueue({
      spacingMs: 8_000,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    const order: string[] = [];
    const a = q.run(async () => {
      order.push("a start");
      now += 2_000;
      order.push("a end");
      return 1;
    });
    const b = q.run(async () => {
      order.push("b");
      throw new Error("reverted");
    });
    const c = q.run(async () => {
      order.push("c");
      return 3;
    });
    expect(await a).toBe(1);
    await expect(b).rejects.toThrow("reverted");
    expect(await c).toBe(3);
    expect(order).toEqual(["a start", "a end", "b", "c"]);
    expect(slept).toEqual([8_000, 8_000]);
  });
});
