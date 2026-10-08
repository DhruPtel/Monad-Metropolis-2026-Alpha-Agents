// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";
import {IChainlinkFeed, IOracleAdapter, IUniswapV4StateView, OracleReason} from "../../src/interfaces/IOracle.sol";
import {MockFeed, MockStateView} from "../mocks/OracleMocks.sol";

/// The adapter with its pool price set directly, so the 2% rule can be tested
/// at its exact boundary; the sqrtPriceX96 conversion is tested separately.
contract PoolPriceHarness is OracleAdapter {
    uint256 public forcedPool;
    bool public forced;

    constructor(Config memory c) OracleAdapter(c) {}

    function forcePool(uint256 p) external {
        forcedPool = p;
        forced = true;
    }

    function _pool() internal view override returns (uint256, OracleReason) {
        if (!forced) return super._pool();
        if (forcedPool == 0) return (0, OracleReason.POOL_UNREADABLE);
        return (forcedPool, OracleReason.OK);
    }
}

/// Shared setup: the launch configuration (MON/USD 300 s, USDC/USD 3,900 s,
/// 2% deviation, 1% depeg) over mock feeds and a mock StateView, at the
/// prices P2-U0 measured at the pinned block.
abstract contract OracleBase is Test {
    bytes32 internal constant POOL_ID = 0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954;
    uint256 internal constant MON_MAX_AGE = 300;
    uint256 internal constant USDC_MAX_AGE = 7_200;
    uint256 internal constant MAX_DEVIATION_BPS = 200;
    uint256 internal constant MAX_DEPEG_BPS = 100;
    /// MON/USD at the pinned block: $0.03436820 (8 decimals).
    int256 internal constant MON_ANSWER = 3_436_820;
    uint256 internal constant MON_PRICE_E18 = 34_368_200_000_000_000;

    address internal usdcToken = makeAddr("usdc token");
    address internal wmonToken = makeAddr("wmon token");
    MockFeed internal monFeed;
    MockFeed internal usdcFeed;
    MockStateView internal stateView;
    OracleAdapter internal adapter;

    function setUp() public virtual {
        vm.warp(1_790_876_425);
        monFeed = new MockFeed(8);
        usdcFeed = new MockFeed(8);
        stateView = new MockStateView(POOL_ID);
        monFeed.push(MON_ANSWER);
        usdcFeed.push(99_999_000);
        stateView.setSqrtPrice(sqrtFor(MON_PRICE_E18));
        adapter = new OracleAdapter(config());
    }

    function config() internal view returns (OracleAdapter.Config memory) {
        return OracleAdapter.Config({
            usdc: usdcToken,
            wmon: wmonToken,
            monUsdFeed: IChainlinkFeed(address(monFeed)),
            monUsdDecimals: 8,
            monUsdMaxAge: MON_MAX_AGE,
            usdcUsdFeed: IChainlinkFeed(address(usdcFeed)),
            usdcUsdDecimals: 8,
            usdcUsdMaxAge: USDC_MAX_AGE,
            stateView: IUniswapV4StateView(address(stateView)),
            poolId: POOL_ID,
            maxDeviationBps: MAX_DEVIATION_BPS,
            maxDepegBps: MAX_DEPEG_BPS
        });
    }

    /// The v4 sqrtPriceX96 whose price is closest to `priceE18` (a whole MON's USDC value, 1e18 scale).
    function sqrtFor(uint256 priceE18) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(priceE18, 2 ** 192, 1e30)));
    }

    function unavailable(address asset, OracleReason reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IOracleAdapter.OracleUnavailable.selector, asset, reason);
    }

    function assertReason(OracleReason actual, OracleReason expected) internal pure {
        assertEq(uint8(actual), uint8(expected), "reason");
    }
}
