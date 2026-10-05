import { type Address, encodeAbiParameters, getContractAddress, concat, type Hex } from "viem";

/**
 * Token-bound account addresses (ERC-6551, canonical Tokenbound v3).
 *
 * The registry deploys an ERC-1167 clone by CREATE2 with salt `salt`, whose
 * init code holds the implementation argument and, as a footer,
 * `abi.encode(salt, chainId, tokenContract, tokenId)` (Planv2/notes/
 * tokenbound.md 2.5). For Tokenbound v3 the implementation argument is the
 * AccountProxy, not AccountV3Upgradable. AgentNFT uses salt 0.
 *
 * tokenbound.test.ts checks this against @tokenbound/sdk and, on the local
 * fork, against the canonical registry's own `account()`.
 */
const CLONE_HEAD = "0x3d60ad80600a3d3981f3363d3d373d3d3d363d73";
const CLONE_TAIL = "0x5af43d82803e903d91602b57fd5bf3";

export interface TokenboundAccountParams {
  readonly registry: Address;
  /** The AccountProxy for Tokenbound v3. */
  readonly implementation: Address;
  readonly chainId: number;
  readonly tokenContract: Address;
  readonly tokenId: bigint;
  /** Defaults to 0, which AgentNFT uses. */
  readonly salt?: Hex;
}

const ZERO_SALT: Hex = `0x${"00".repeat(32)}`;

export function tokenboundAccountAddress(p: TokenboundAccountParams): Address {
  const salt = p.salt ?? ZERO_SALT;
  const footer = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
    [salt, BigInt(p.chainId), p.tokenContract, p.tokenId],
  );
  return getContractAddress({
    opcode: "CREATE2",
    from: p.registry,
    salt,
    bytecode: concat([CLONE_HEAD, p.implementation, CLONE_TAIL, footer]),
  });
}
