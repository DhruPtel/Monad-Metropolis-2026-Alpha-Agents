// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {
    FeedConfig,
    FeedLeg,
    IPoolRegistry,
    ITokenRegistry,
    PriceClass,
    PriceReason,
    TokenRecord
} from "../interfaces/IFund.sol";
import {IUniswapV4StateView} from "../interfaces/IOracle.sol";
import {OracleAdapterV3} from "./OracleAdapterV3.sol";

/// @title QuoteOracleV3
/// @notice A testnet price mode for dev deploys only (2026-10-16): a token's
/// price is its own pool's spot, not a feed, for tokens that exist only on a
/// testnet's venues and have no feed. The judged stacks keep OracleAdapterV3.
///
/// - A class F token's "feed" in the TokenRegistry names its pricing pool: the
///   registered pool (a Uniswap v2 family pair) against USDC or WMON that
///   prices it. WMON is priced by its own pool against USDC, so every price
///   ends in USDC.
/// - `quoteMode` tells the Executor to check a trade's fill against the
///   route's own quote (RouteAdapter.quoteRoute), not against these prices.
/// - The pool-to-oracle band still applies to every hop, against these prices.
/// - The stack's USDC is the numeraire: its own feed leg (the custody deposit
///   guard's peg check) reads exactly 1 USD; no other leg is a feed here.
contract QuoteOracleV3 is OracleAdapterV3 {
    constructor(
        ITokenRegistry tokens,
        IPoolRegistry pools,
        IUniswapV4StateView stateView,
        address usdc,
        address wmon,
        uint256 maxDeviationBps
    ) OracleAdapterV3(tokens, pools, stateView, usdc, wmon, maxDeviationBps) {}

    function quoteMode() external pure override returns (bool) {
        return true;
    }

    /// USDC's own leg is exactly 1 USD; any other leg is not a feed in this mode.
    function readLeg(FeedLeg memory leg)
        public
        view
        override
        returns (uint256 valueE18, uint256 updatedAt, PriceReason reason)
    {
        if (leg.feed != address(0) && leg.feed == TOKENS.feedOf(USDC).usd.feed) {
            return (ONE_E18, block.timestamp, PriceReason.OK);
        }
        return (0, 0, PriceReason.FEED_REVERTED);
    }

    /// The token's price from its pricing pool, as of this block.
    function price(address token)
        public
        view
        override
        returns (uint256 priceE18_, uint256 updatedAt, PriceReason reason)
    {
        if (token == USDC) return (ONE_E18, block.timestamp, PriceReason.OK);
        TokenRecord memory r = TOKENS.tokenRecord(token);
        if (r.priceClass == PriceClass.NONE) return (0, 0, PriceReason.UNKNOWN_ASSET);
        if (r.priceClass == PriceClass.A) return (0, 0, PriceReason.ATTESTATION_REQUIRED);
        FeedConfig memory f = TOKENS.feedOf(token);
        if (f.usd.feed == address(0)) return (0, 0, PriceReason.POOL_UNSUPPORTED);
        (priceE18_, reason) = poolPrice(token, bytes32(uint256(uint160(f.usd.feed))));
        return (priceE18_, block.timestamp, reason);
    }
}
