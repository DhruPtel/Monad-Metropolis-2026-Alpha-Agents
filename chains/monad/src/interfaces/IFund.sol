// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// Shared types of the fund agent's contract set, v3 (FINAL_PLAN 0.4, F-U2).
/// Written clean-room from the plan.

/// How a token or pool entered the registry (D-342, D-351). CORE entries wait
/// the 9-day timelock and serve every account; SCREENED entries are added at
/// once by the screener role and serve only personal accounts whose owner opted in.
enum Lane {
    NONE,
    CORE,
    SCREENED
}

/// A token's trading status, strictest last. Tightening is instant for the
/// screener, the guardian and the admin; loosening waits the timelock (D-340).
enum TokenStatus {
    NONE,
    BUYABLE,
    SELL_ONLY,
    FROZEN
}

/// A pool's status, strictest last: EXIT_ONLY only carries routes that end in USDC.
enum PoolStatus {
    NONE,
    ACTIVE,
    EXIT_ONLY,
    PAUSED
}

/// How a token is priced (D-337): F by its feed legs, A by a platform attestation (F-U12).
enum PriceClass {
    NONE,
    F,
    A
}

/// The venues a route may cross. Uniswap v4 pools are hookless only (Q-35).
enum Venue {
    NONE,
    UNISWAP_V3,
    PANCAKESWAP_V3,
    UNISWAP_V4
}

/// Why a price was refused, or OK. The order matches PRICE_REASONS in
/// packages/policy/src/fund.ts, which a parity test checks: an enum crosses
/// the ABI as its index.
enum PriceReason {
    OK,
    /// The token is not in the TokenRegistry.
    UNKNOWN_ASSET,
    /// A class A token: priced only by an attestation (F-U12).
    ATTESTATION_REQUIRED,
    /// A feed leg reverted, or answered with too little data to decode.
    FEED_REVERTED,
    /// A feed leg's decimals are not the ones recorded for it.
    DECIMALS_MISMATCH,
    /// A feed leg's answer is zero or negative.
    ANSWER_NOT_POSITIVE,
    /// A feed leg's answer, scaled to 18 decimals, is above 2^128 - 1.
    ANSWER_OUT_OF_RANGE,
    /// A feed leg's `updatedAt` is zero, or its answer comes from an earlier round.
    ROUND_INCOMPLETE,
    /// A feed leg's `updatedAt` is after the block's timestamp.
    FUTURE_TIMESTAMP,
    /// A feed leg's answer is as old as its own bound or older.
    STALE,
    /// The pool's price could not be read, or is zero.
    POOL_UNREADABLE,
    /// The pool's price is too far from the oracle's.
    POOL_DEVIATION,
    /// The pool does not price this token against USDC or WMON.
    POOL_UNSUPPORTED
}

/// One Chainlink feed leg: the proxy, its decimals and its own staleness
/// bound in seconds (300 for MON/USD, the heartbeat plus 300 for the rest).
struct FeedLeg {
    address feed;
    uint8 decimals;
    uint32 maxAge;
}

/// A class F token's pricing: `usd` alone prices it; with `rate` set, the
/// token's price is the exchange rate (token to the base asset) times `usd`
/// (the base asset's USD price), as for MON's liquid staking tokens.
struct FeedConfig {
    FeedLeg usd;
    FeedLeg rate;
}

/// One token in the TokenRegistry.
struct TokenRecord {
    Lane lane;
    TokenStatus status;
    PriceClass priceClass;
    uint8 decimals;
    /// Most of an account's value this token may be, in basis points.
    uint16 maxPositionBps;
    /// The latest passing screen's time and the hash of its result (D-339).
    uint64 screenedAt;
    bytes32 screenHash;
}

/// One pool in the ProtocolRegistryV3. `pool` is the v3 pool's address, zero
/// for v4; `codeHash` pins the v3 pool's code, or v4's PoolManager's. Uniswap
/// v4 pools carry their key's fee and tick spacing; their hooks are always zero.
struct PoolRecord {
    Lane lane;
    PoolStatus status;
    Venue venue;
    address token0;
    address token1;
    uint24 fee;
    int24 tickSpacing;
    address pool;
    bytes32 codeHash;
}

/// What the registries ask of an account (F-U3's PersonalAccount and vault
/// implement it): whether its owner opted in to screened tokens (D-351) and
/// whether it is a public vault, which never holds screened tokens.
interface IRegistryAccount {
    function screenedOptIn() external view returns (bool);
    function isVault() external view returns (bool);
}

/// The attested price verifier F-U12 builds (D-337): checks the attestor's
/// EIP-712 signature and expiry and returns the attested price.
interface IAttestationVerifier {
    function verify(bytes calldata attestation)
        external
        view
        returns (address token, uint256 priceE18, uint64 validUntil);
}

/// The TokenRegistry as the oracle and later the Executor read it.
interface ITokenRegistry {
    function tokenRecord(address token) external view returns (TokenRecord memory);
    function feedOf(address token) external view returns (FeedConfig memory);
    function verifier() external view returns (address);
    function buyableFor(address token, address account) external view returns (bool);
    function sellable(address token) external view returns (bool);
}

/// The ProtocolRegistryV3 as the route adapter and the oracle read it.
interface IPoolRegistry {
    /// A pool's record as registered, whatever its status.
    function pool(bytes32 poolId) external view returns (PoolRecord memory);

    /// The pool's record when a route may use it now, else reverts.
    function usablePool(bytes32 poolId, bool allowScreened, bool toUsdc) external view returns (PoolRecord memory);
}
