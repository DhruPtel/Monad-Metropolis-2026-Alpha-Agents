import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  type AgentChainView,
  type ArmingRecord,
  MAX_GRANT_SECONDS,
  RENEWAL_REMINDER_SECONDS,
  armingEnd,
  armingState,
  grantDate,
  grantProblem,
  renewalDue,
} from "./arming.ts";

const OWNER = "0x00000000000000000000000000000000000a11ce" as Hex;
const BUYER = "0x00000000000000000000000000000000000b0b00" as Hex;
const KEY = "0x00000000000000000000000000000000000000ee" as Hex;
const NOW = 1_790_000_000n;

const arming = (over: Partial<ArmingRecord> = {}): ArmingRecord => ({
  armingId: "arming-1",
  chainId: 143143,
  agentId: 1,
  custody: "v2",
  executor: null,
  owner: OWNER,
  ownerEpoch: 2n,
  configEpoch: 5n,
  sessionKey: KEY,
  validUntil: NOW + 86_400n,
  status: "armed",
  endedReason: null,
  firstIntentId: "intent-1",
  revokedOnchain: false,
  remindedAt: null,
  armedAt: new Date(),
  endedAt: null,
  createdAt: new Date(),
  ...over,
});

const chain = (over: Partial<AgentChainView> = {}): AgentChainView => ({
  owner: OWNER,
  ownerEpoch: 2n,
  configEpoch: 5n,
  grant: { key: KEY, ownerEpoch: 2n, configEpoch: 5n, validUntil: NOW + 86_400n },
  timestamp: NOW,
  ...over,
});

describe("arming ends (P2-U6)", () => {
  it("holds while the owner, epochs and grant are the ones armed", () => {
    expect(armingEnd(arming(), chain())).toBeNull();
    // A renewed grant (same key and epochs, later expiry) still holds.
    const renewed = chain({
      grant: { key: KEY, ownerEpoch: 2n, configEpoch: 5n, validUntil: NOW + 20n * 86_400n },
    });
    expect(armingEnd(arming(), renewed)).toBeNull();
  });

  it("ends on a sale, by owner or by owner epoch", () => {
    expect(armingEnd(arming(), chain({ owner: BUYER, ownerEpoch: 3n }))).toBe("sold");
    expect(armingEnd(arming(), chain({ ownerEpoch: 3n }))).toBe("sold");
  });

  it("ends on a configuration change", () => {
    expect(armingEnd(arming(), chain({ configEpoch: 6n }))).toBe("config_changed");
  });

  it("ends when the grant expires", () => {
    expect(armingEnd(arming(), chain({ timestamp: NOW + 86_400n }))).toBe("expired");
  });

  it("ends when the grant is revoked or replaced on chain", () => {
    expect(armingEnd(arming(), chain({ grant: null }))).toBe("revoked");
    const other = "0x00000000000000000000000000000000000000ff" as Hex;
    expect(
      armingEnd(
        arming(),
        chain({ grant: { key: other, ownerEpoch: 2n, configEpoch: 5n, validUntil: NOW + 9n } }),
      ),
    ).toBe("revoked");
  });

  it("states: none or ended is unarmed", () => {
    expect(armingState(null)).toBe("unarmed");
    expect(armingState(arming({ status: "ended", endedReason: "disarmed" }))).toBe("unarmed");
    expect(armingState(arming({ status: "awaiting_first_trade" }))).toBe("awaiting_first_trade");
    expect(armingState(arming())).toBe("armed");
  });
});

describe("a grant that can arm the agent", () => {
  it("accepts the owner's grant to the funding address within 30 days", () => {
    expect(grantProblem(chain(), OWNER, KEY)).toBeNull();
  });

  it("refuses another wallet, no grant, another key, stale epochs, expired or too long", () => {
    expect(grantProblem(chain(), BUYER, KEY)).toMatch(/owner/);
    expect(grantProblem(chain({ grant: null }), OWNER, KEY)).toMatch(/No trading permission/);
    expect(grantProblem(chain(), OWNER, BUYER)).toMatch(/different key/);
    expect(grantProblem(chain({ ownerEpoch: 3n }), OWNER, KEY)).toMatch(/before/);
    expect(grantProblem(chain({ timestamp: NOW + 86_400n }), OWNER, KEY)).toMatch(/expired/);
    const long = chain({
      grant: {
        key: KEY,
        ownerEpoch: 2n,
        configEpoch: 5n,
        validUntil: NOW + BigInt(MAX_GRANT_SECONDS) + 1n,
      },
    });
    expect(grantProblem(long, OWNER, KEY)).toMatch(/30 days/);
  });
});

describe("the renewal reminder", () => {
  it("is due once inside the reminder window", () => {
    const r = arming({ validUntil: NOW + BigInt(RENEWAL_REMINDER_SECONDS) + 10n });
    expect(renewalDue(r, NOW)).toBe(false);
    expect(renewalDue(r, NOW + 10n)).toBe(true);
    expect(renewalDue({ ...r, remindedAt: new Date() }, NOW + 10n)).toBe(false);
    expect(renewalDue({ ...r, status: "ended" }, NOW + 10n)).toBe(false);
    expect(grantDate(1_790_000_000n)).toBe("2026-09-21");
  });
});
