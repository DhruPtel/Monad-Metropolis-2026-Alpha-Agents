// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    FeedConfig,
    FeedLeg,
    IAttestationVerifier,
    IPoolRegistry,
    ITokenRegistry,
    PoolRecord,
    PriceClass,
    PriceReason,
    TokenRecord,
    Venue
} from "../interfaces/IFund.sol";
import {IChainlinkFeed, IUniswapV4StateView} from "../interfaces/IOracle.sol";

/// @title OracleAdapterV3
/// @notice Prices for the fund agent's set (FINAL_PLAN 0.2, 0.4, D-337),
/// written clean-room. Every price is the USDC value of one whole token,
/// scaled by 1e18, with USDC exactly 1.
///
/// - Class F tokens are priced by their own feed legs from the TokenRegistry,
///   each checked as the launch adapter checks MON/USD (the feed answers, its
///   decimals are the recorded ones, the answer is positive and fits, the round
///   is complete, not from the future) against its own staleness bound: 300
///   seconds for MON/USD, the measured heartbeat plus 300 seconds for the rest
///   (F-U2's feed spike). A composite token (a liquid staking token) is its
///   exchange rate times its base asset's USD feed. One stale feed blocks only
///   the tokens it prices.
/// - Class A tokens have no feed: `price` answers ATTESTATION_REQUIRED, and
///   `attestedPriceE18` checks an attestation through the verifier the
///   registry names (F-U12 builds it).
/// - A trade also needs the pool it trades in within 2% of the oracle price
///   (the existing rule), for pools pricing the token against USDC or WMON.
/// - Withdrawals never read this contract (D-335).
contract OracleAdapterV3 {
    uint256 public constant BPS = 10_000;
    uint256 public constant ONE_E18 = 1e18;
    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant MAX_PRICE_E18 = type(uint128).max;

    ITokenRegistry public immutable TOKENS;
    IPoolRegistry public immutable POOLS;
    IUniswapV4StateView public immutable STATE_VIEW;
    address public immutable USDC;
    address public immutable WMON;
    /// Most a pool may be from the oracle, as a share of the oracle price.
    uint256 public immutable MAX_DEVIATION_BPS;

    error BadConfig(string what);
    error PriceUnavailable(address token, PriceReason reason);
    error NoVerifier();
    error BadAttestation(address token);

    constructor(
        ITokenRegistry tokens,
        IPoolRegistry pools,
        IUniswapV4StateView stateView,
        address usdc,
        address wmon,
        uint256 maxDeviationBps
    ) {
        if (address(tokens) == address(0) || address(pools) == address(0) || address(stateView) == address(0)) {
            revert BadConfig("registries");
        }
        if (usdc == address(0) || wmon == address(0) || usdc == wmon) revert BadConfig("assets");
        if (maxDeviationBps == 0 || maxDeviationBps >= BPS) revert BadConfig("deviation");
        TOKENS = tokens;
        POOLS = pools;
        STATE_VIEW = stateView;
        USDC = usdc;
        WMON = wmon;
        MAX_DEVIATION_BPS = maxDeviationBps;
    }

    // ---------------------------------------------------------------------
    // Views that never revert
    // ---------------------------------------------------------------------

    /// A token's oracle price, the oldest leg's update time, and why it is unusable, if it is.
    function price(address token) public view returns (uint256 priceE18_, uint256 updatedAt, PriceReason reason) {
        if (token == USDC) return (ONE_E18, block.timestamp, PriceReason.OK);
        TokenRecord memory r = TOKENS.tokenRecord(token);
        if (r.priceClass == PriceClass.NONE) return (0, 0, PriceReason.UNKNOWN_ASSET);
        if (r.priceClass == PriceClass.A) return (0, 0, PriceReason.ATTESTATION_REQUIRED);
        FeedConfig memory f = TOKENS.feedOf(token);
        uint256 usd;
        (usd, updatedAt, reason) = readLeg(f.usd);
        if (reason != PriceReason.OK || f.rate.feed == address(0)) return (usd, updatedAt, reason);
        (uint256 rate, uint256 rateAt, PriceReason rateReason) = readLeg(f.rate);
        if (rateReason != PriceReason.OK) return (0, rateAt, rateReason);
        priceE18_ = Math.mulDiv(rate, usd, ONE_E18);
        if (priceE18_ == 0 || priceE18_ > MAX_PRICE_E18) return (0, rateAt, PriceReason.ANSWER_OUT_OF_RANGE);
        return (priceE18_, rateAt < updatedAt ? rateAt : updatedAt, PriceReason.OK);
    }

    /// One feed leg, every check in a fixed order (packages/policy's `readLegV3` checks in the same order).
    function readLeg(FeedLeg memory leg) public view returns (uint256 valueE18, uint256 updatedAt, PriceReason reason) {
        (bool ok, bytes memory ret) = leg.feed.staticcall(abi.encodeCall(IChainlinkFeed.decimals, ()));
        if (!ok || ret.length < 32) return (0, 0, PriceReason.FEED_REVERTED);
        if (abi.decode(ret, (uint256)) != leg.decimals) return (0, 0, PriceReason.DECIMALS_MISMATCH);

        (ok, ret) = leg.feed.staticcall(abi.encodeCall(IChainlinkFeed.latestRoundData, ()));
        if (!ok || ret.length < 160) return (0, 0, PriceReason.FEED_REVERTED);
        // Decoded as full words, so a malformed answer cannot make the decode revert.
        (uint256 roundId, int256 answer,, uint256 updated, uint256 answeredInRound) =
            abi.decode(ret, (uint256, int256, uint256, uint256, uint256));

        if (answer <= 0) return (0, updated, PriceReason.ANSWER_NOT_POSITIVE);
        uint256 scale = 10 ** (18 - uint256(leg.decimals));
        // forge-lint: disable-next-line(unsafe-typecast)
        if (uint256(answer) > MAX_PRICE_E18 / scale) return (0, updated, PriceReason.ANSWER_OUT_OF_RANGE);
        if (updated == 0 || answeredInRound < roundId) return (0, updated, PriceReason.ROUND_INCOMPLETE);
        // forge-lint: disable-next-line(block-timestamp)
        if (updated > block.timestamp) return (0, updated, PriceReason.FUTURE_TIMESTAMP);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp - updated >= leg.maxAge) return (0, updated, PriceReason.STALE);
        // forge-lint: disable-next-line(unsafe-typecast)
        return (uint256(answer) * scale, updated, PriceReason.OK);
    }

    /// A pool's spot price for `token` against USDC or WMON, as the USDC value of one whole token.
    function poolPrice(address token, bytes32 poolId) public view returns (uint256 priceE18_, PriceReason reason) {
        PoolRecord memory p = POOLS.pool(poolId);
        address a = _held(p.token0);
        address b = _held(p.token1);
        address other;
        if (token == a) other = b;
        else if (token == b) other = a;
        else return (0, PriceReason.POOL_UNSUPPORTED);
        uint256 otherPrice;
        if (other == USDC) {
            otherPrice = ONE_E18;
        } else if (other == WMON) {
            (otherPrice,, reason) = price(WMON);
            if (reason != PriceReason.OK) return (0, reason);
        } else {
            return (0, PriceReason.POOL_UNSUPPORTED);
        }
        uint256 sqrtPriceX96 = _sqrtPrice(p, poolId);
        if (sqrtPriceX96 == 0 || sqrtPriceX96 > type(uint160).max) return (0, PriceReason.POOL_UNREADABLE);
        uint256 tokenUnit = 10 ** uint256(TOKENS.tokenRecord(token).decimals);
        uint256 otherUnit = 10 ** uint256(other == USDC ? 6 : 18);
        if (token == a) {
            // other per token, raw, times 2^96.
            uint256 ratioX96 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, Q96);
            priceE18_ = Math.mulDiv(ratioX96, tokenUnit * otherPrice, Q96 * otherUnit);
        } else {
            // other per token, raw, as 2^192 / sqrtPrice^2.
            uint256 inv = Math.mulDiv(Q96, Q96, sqrtPriceX96);
            priceE18_ = Math.mulDiv(inv, tokenUnit * otherPrice, sqrtPriceX96 * otherUnit);
        }
        if (priceE18_ == 0) return (0, PriceReason.POOL_UNREADABLE);
        return (priceE18_, PriceReason.OK);
    }

    /// The pool's distance from the oracle in basis points (rounded down), and
    /// OK, POOL_DEVIATION, or why either price is unusable. Checked exactly.
    function poolDeviationBps(address token, bytes32 poolId) public view returns (uint256 bps, PriceReason reason) {
        (, bps, reason) = _deviation(token, poolId);
    }

    // ---------------------------------------------------------------------
    // Reverting forms
    // ---------------------------------------------------------------------

    function priceE18(address token) external view returns (uint256 p) {
        PriceReason reason;
        (p,, reason) = price(token);
        if (reason != PriceReason.OK) revert PriceUnavailable(token, reason);
    }

    /// The oracle price after the pool deviation check, for a trade through `poolId`.
    function tradablePriceE18(address token, bytes32 poolId) external view returns (uint256 p) {
        PriceReason reason;
        (p,, reason) = _deviation(token, poolId);
        if (reason != PriceReason.OK) revert PriceUnavailable(token, reason);
    }

    /// A class A token's price from an attestation, through the registry's verifier (F-U12).
    function attestedPriceE18(address token, bytes calldata attestation) external view returns (uint256) {
        address v = TOKENS.verifier();
        if (v == address(0)) revert NoVerifier();
        (address attested, uint256 p, uint64 validUntil) = IAttestationVerifier(v).verify(attestation);
        // forge-lint: disable-next-line(block-timestamp)
        if (attested != token || p == 0 || p > MAX_PRICE_E18 || validUntil < block.timestamp) {
            revert BadAttestation(token);
        }
        return p;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _deviation(address token, bytes32 poolId)
        internal
        view
        returns (uint256 oracle, uint256 bps, PriceReason reason)
    {
        (oracle,, reason) = price(token);
        if (reason != PriceReason.OK || token == USDC) return (oracle, 0, reason);
        uint256 pool;
        (pool, reason) = poolPrice(token, poolId);
        if (reason != PriceReason.OK) return (oracle, 0, reason);
        uint256 diff = pool > oracle ? pool - oracle : oracle - pool;
        bps = diff * BPS / oracle;
        reason = diff * BPS <= oracle * MAX_DEVIATION_BPS ? PriceReason.OK : PriceReason.POOL_DEVIATION;
    }

    /// The pool's sqrtPriceX96: StateView for v4, the pool's own slot0 (first word) for v3.
    function _sqrtPrice(PoolRecord memory p, bytes32 poolId) internal view returns (uint256) {
        bool ok;
        bytes memory ret;
        if (p.venue == Venue.UNISWAP_V4) {
            (ok, ret) = address(STATE_VIEW).staticcall(abi.encodeCall(IUniswapV4StateView.getSlot0, (poolId)));
        } else if (p.venue == Venue.UNISWAP_V3 || p.venue == Venue.PANCAKESWAP_V3) {
            (ok, ret) = p.pool.staticcall(abi.encodeWithSignature("slot0()"));
        }
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    function _held(address currency) internal view returns (address) {
        return currency == address(0) ? WMON : currency;
    }
}
