import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import {
  type HoldingsClient,
  type HoldingsReading,
  holdingsJson,
  rpcHoldingsReader,
  tokenBoundRecoverCall,
} from "./holdings.ts";

const OWNER = "0x683eE842A16f85e69883F433745263BFe8D55f76" as const;
const FUNDING = "0x45BB3eC560c7A19bbedad9cB42051401Ecc30d7B" as const;
const TBA = "0x487ff500699226631e477F54eaeF41537a5eccAA" as const;
const ACCOUNT = "0x88EF98439A62BADab65D14B0FE5442bba47FFDCb" as const;
const USDC = {
  symbol: "USDC",
  address: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
  decimals: 6,
} as const;
const WMON = {
  symbol: "WMON",
  address: "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541",
  decimals: 18,
} as const;
const TBA_ABI = parseAbi([
  "function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)",
]);
const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/** Agent 2 on testnet as the owner left it: MON and USDC sent to its token-bound account. */
const reading = (over: Partial<HoldingsReading> = {}): HoldingsReading => ({
  chainId: 10143,
  block: 100n,
  agentId: 2,
  owner: OWNER,
  addresses: [
    {
      role: "funding",
      address: FUNDING,
      native: 5n * 10n ** 17n,
      tokens: [
        { token: USDC, raw: 10_000_000n },
        { token: WMON, raw: 0n },
      ],
    },
    {
      role: "token_bound",
      address: TBA,
      native: 3n * 10n ** 18n,
      tokens: [
        { token: USDC, raw: 5_000_000n },
        { token: WMON, raw: 0n },
      ],
    },
    {
      role: "personal_account",
      address: ACCOUNT,
      native: 0n,
      tokens: [
        { token: USDC, raw: 5_000_000n },
        { token: WMON, raw: 0n },
      ],
    },
  ],
  ...over,
});

describe("an agent's holdings at every address (D-315)", () => {
  it("lists what each address is for, even at zero, and anything else it holds", () => {
    const j = holdingsJson(reading());
    const view = j.addresses.map((a) => [
      a.role,
      a.holdings.map((h) => `${h.symbol}:${h.raw}:${h.use}:${h.status}`),
    ]);
    expect(view).toEqual([
      ["funding", ["MON:500000000000000000:gas:in_use", "USDC:10000000:credits:in_use"]],
      ["token_bound", ["MON:3000000000000000000:null:movable", "USDC:5000000:null:movable"]],
      ["personal_account", ["USDC:5000000:trading:in_use", "WMON:0:trading:in_use"]],
    ]);
  });

  it("offers the owner a call that moves each stranded asset of the token-bound account to the owner", () => {
    const tba = holdingsJson(reading()).addresses[1];
    const [mon, usdc] = tba?.holdings ?? [];
    expect(mon?.recoverCall?.to).toBe(TBA);
    expect(mon?.recoverCall?.value).toBe("0");
    const monCall = decodeFunctionData({ abi: TBA_ABI, data: mon?.recoverCall?.data ?? "0x" });
    expect(monCall.args).toEqual([OWNER, 3n * 10n ** 18n, "0x", 0]);
    const usdcCall = decodeFunctionData({ abi: TBA_ABI, data: usdc?.recoverCall?.data ?? "0x" });
    expect(usdcCall.args.slice(0, 2)).toEqual([USDC.address, 0n]);
    const inner = decodeFunctionData({ abi: ERC20_ABI, data: usdcCall.args[2] });
    expect(inner.args).toEqual([OWNER, 5_000_000n]);
  });

  it("marks what does nothing and cannot be moved by the owner, and never offers a call for it", () => {
    const j = holdingsJson(
      reading({
        addresses: [
          { role: "funding", address: FUNDING, native: 0n, tokens: [{ token: WMON, raw: 7n }] },
          { role: "token_bound", address: TBA, native: 0n, tokens: [] },
          { role: "personal_account", address: ACCOUNT, native: 9n, tokens: [] },
        ],
      }),
    );
    expect(j.addresses[0]?.holdings).toContainEqual(
      expect.objectContaining({ symbol: "WMON", status: "platform_only", recoverCall: null }),
    );
    expect(j.addresses[1]?.holdings).toEqual([]);
    expect(j.addresses[2]?.holdings).toContainEqual(
      expect.objectContaining({ symbol: "MON", status: "stuck", recoverCall: null }),
    );
  });

  it("marks what the older v2 account holds as the owner's to withdraw from the portfolio page, never as in use nor movable here (A-80)", () => {
    const j = holdingsJson(
      reading({
        addresses: [
          {
            role: "older_account",
            address: ACCOUNT,
            native: 10n ** 15n,
            tokens: [
              { token: USDC, raw: 100_000_000n },
              { token: WMON, raw: 0n },
            ],
          },
        ],
      }),
    );
    expect(j.addresses[0]).toMatchObject({ role: "older_account", address: ACCOUNT });
    expect(j.addresses[0]?.holdings.map((h) => [h.symbol, h.status, h.use, h.recoverCall])).toEqual(
      [
        ["MON", "stuck", null, null],
        ["USDC", "older", null, null],
      ],
    );
  });

  it("shows an address that does not exist yet as empty, with nothing to move", () => {
    const j = holdingsJson(
      reading({
        addresses: [
          { role: "funding", address: null, native: 0n, tokens: [] },
          { role: "token_bound", address: TBA, native: 0n, tokens: [] },
          { role: "personal_account", address: null, native: 0n, tokens: [] },
        ],
      }),
    );
    expect(j.addresses.map((a) => a.address)).toEqual([null, TBA, null]);
    expect(
      j.addresses.flatMap((a) => a.holdings.map((h) => h.recoverCall)).filter(Boolean),
    ).toEqual([]);
  });

  it("encodes the MON call with value 0: the account pays the MON, not the owner", () => {
    expect(tokenBoundRecoverCall(TBA, OWNER, null, 1n).value).toBe("0");
  });
});

describe("the trading account's line on the holdings card (2026-10-17)", () => {
  const NFT = "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E" as const;
  const FACTORY_V3 = "0x5ebF58520f9bAa847959DcF69716030a1583BCDb" as const;
  const TALPHA = "0xD4EB3FeF2A9eBE27D59D4188B6D20Bb21220c03c" as const;
  const TBETA = "0x57ca16ca75E968Bd3FF712C729e6e5F6940Cc010" as const;
  const lower = (a: string) => a.toLowerCase();
  /** Agent #2's account after its first plan: USDC, WMON and the two stand-ins. */
  const balanceIn: Record<string, bigint> = {
    [lower(USDC.address)]: 1_505_996n,
    [lower(WMON.address)]: 899_149_840_245_530_587n,
    [lower(TALPHA)]: 2_080_920_225_587_341_937n,
    [lower(TBETA)]: 1_472_165_830_939_333_516n,
  };
  const client = (): HoldingsClient & { reads: string[] } => {
    const reads: string[] = [];
    return {
      reads,
      async getBalance() {
        return 0n;
      },
      async getBlockNumber() {
        return 100n;
      },
      async readContract({ address, functionName, args = [] }) {
        reads.push(`${functionName}@${lower(address).slice(0, 8)}`);
        const at = lower(address);
        if (at === lower(NFT) && functionName === "ownerOf") return OWNER;
        if (at === lower(NFT) && functionName === "tbaOf") return TBA;
        if (at === lower(FACTORY_V3) && functionName === "personalAccountOf") return ACCOUNT;
        if (functionName === "balanceOf")
          return lower(String(args[0])) === lower(ACCOUNT) ? (balanceIn[at] ?? 0n) : 0n;
        if (at === lower(ACCOUNT) && functionName === "holdings")
          return [USDC.address, WMON.address, TALPHA, TBETA].map((token) => ({
            token,
            decimals: token === USDC.address ? 6 : 18,
            balance: balanceIn[lower(token)] ?? 0n,
            free: balanceIn[lower(token)] ?? 0n,
            costBasis: 0n,
            lastPriceE18: 0n,
            lastPricedAt: 0n,
          }));
        if (functionName === "symbol") {
          if (at === lower(TALPHA)) return "TALPHA";
          if (at === lower(TBETA)) return "TBETA";
        }
        throw new Error(`unexpected read ${functionName} at ${address}`);
      },
    };
  };

  it("lists every token the account holds, named from the chain, beside the address book's tokens", async () => {
    const fake = client();
    const reader = rpcHoldingsReader(
      "http://unused",
      10143,
      { agentNft: NFT, accountFactory: null, accountFactoryV3: FACTORY_V3, tokens: [USDC, WMON] },
      fake,
    );
    const r = await reader.holdings(2, FUNDING);
    const account = holdingsJson(r as HoldingsReading).addresses.find(
      (a) => a.role === "personal_account",
    );
    expect(account?.holdings.map((h) => `${h.symbol}:${h.raw}:${h.use}`)).toEqual([
      "USDC:1505996:trading",
      "WMON:899149840245530587:trading",
      "TALPHA:2080920225587341937:trading",
      "TBETA:1472165830939333516:trading",
    ]);
    // Only the trading account is read for its own list; the other addresses keep the book's.
    expect(fake.reads.filter((x) => x.startsWith("holdings@"))).toEqual([
      `holdings@${lower(ACCOUNT).slice(0, 8)}`,
    ]);
  });
});
