// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AccountFactory} from "../../src/custody/AccountFactory.sol";
import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";
import {IChainlinkFeed, IOracleAdapter, IUniswapV4StateView, OracleReason} from "../../src/interfaces/IOracle.sol";
import {MockFeed, MockStateView} from "../mocks/OracleMocks.sol";
import {CustodyBase} from "./CustodyBase.sol";

/// The custody setup with the real oracle adapter over mock feeds and a mock
/// StateView, MON at $1.00 (P2-U3).
abstract contract BreakerBase is CustodyBase {
    bytes32 internal constant POOL_ID = keccak256("pool");
    MockFeed internal monFeed;
    MockFeed internal usdcFeed;
    MockStateView internal stateView;
    OracleAdapter internal adapter;
    /// WMON at $1.00, so a WMON's value is easy to read: 1e18 WMON is 1e6 USDC.
    int256 internal constant ONE_DOLLAR = 1e8;

    function setUp() public virtual override {
        super.setUp();
        monFeed = new MockFeed(8);
        usdcFeed = new MockFeed(8);
        stateView = new MockStateView(POOL_ID);
        adapter = new OracleAdapter(
            OracleAdapter.Config({
                usdc: address(usdc),
                wmon: address(wmon),
                monUsdFeed: IChainlinkFeed(address(monFeed)),
                monUsdDecimals: 8,
                monUsdMaxAge: 300,
                usdcUsdFeed: IChainlinkFeed(address(usdcFeed)),
                usdcUsdDecimals: 8,
                usdcUsdMaxAge: 7_200,
                stateView: IUniswapV4StateView(address(stateView)),
                poolId: POOL_ID,
                maxDeviationBps: 200,
                maxDepegBps: 100
            })
        );
        timelocked(AccountFactory.Action.SetOracle, bytes32(uint256(uint160(address(adapter)))));
        setMon(ONE_DOLLAR);
        usdcFeed.push(1e8);
    }

    // ----- helpers -----

    /// Moves MON/USD (8 decimals) with a fresh round, and the pool with it.
    /// The Executor's quotes follow too, so trades are fair at the new price.
    function setMon(int256 answer) internal {
        monFeed.push(answer);
        uint256 priceE18 = uint256(answer) * 1e10;
        stateView.setSqrtPrice(uint160(Math.sqrt(Math.mulDiv(priceE18, 2 ** 192, 1e30))));
        oracle.set(address(wmon), 18, uint256(answer) / 100);
        usdcFeed.push(1e8);
    }

    function warpDays(uint256 d) internal {
        vm.warp(block.timestamp + d * 1 days);
    }

    function poke() internal returns (uint256 nav, uint256 perUnit_, uint256 peak) {
        return account.poke();
    }

    function perUnit() internal view returns (uint256 p) {
        (, p,,) = account.breakerState();
    }

    function withdraw(address token, uint256 amount) internal {
        vm.prank(owner);
        account.withdraw(token, amount, owner);
    }

    function unavailable(address asset, OracleReason reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IOracleAdapter.OracleUnavailable.selector, asset, reason);
    }

    function wmonAccount() internal {
        deposit(wmon, 50e18); // $50 of WMON, 50 units
    }
}
