// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AccountFactory} from "../../src/custody/AccountFactory.sol";
import {PersonalAccount} from "../../src/custody/PersonalAccount.sol";
import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";
import {AccountMode, IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {IChainlinkFeed, IOracleAdapter, IUniswapV4StateView, OracleReason} from "../../src/interfaces/IOracle.sol";
import {MockAgentNFT} from "../mocks/CustodyMocks.sol";
import {IFiatToken, IWMON} from "./CustodyFork.t.sol";

/// The oracle adapter against Monad's real Chainlink feeds and the real
/// Uniswap v4 MON/USDC pool, at the pinned block, and a PersonalAccount with
/// real USDC and WMON valued through it (P2-U3). Failures the real feeds
/// cannot be made to show on demand (stale, invalid, depegged, a moved pool)
/// are simulated by mocking the real contracts' answers.
///
/// Runs only on a fork named by LOCAL_FORK_URL, which `pnpm test:fork` sets to
/// its own fork on 8546: it never defaults to the playtest fork (L-100).
contract OracleForkTest is Test {
    IFiatToken internal constant USDC = IFiatToken(0x754704Bc059F8C67012fEd69BC8A327a5aafb603);
    IWMON internal constant WMON = IWMON(0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A);
    IChainlinkFeed internal constant MON_USD = IChainlinkFeed(0xBcD78f76005B7515837af6b50c7C52BCf73822fb);
    IChainlinkFeed internal constant USDC_USD = IChainlinkFeed(0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec);
    IUniswapV4StateView internal constant STATE_VIEW = IUniswapV4StateView(0x77395F3b2E73aE90843717371294fa97cC419D64);
    bytes32 internal constant POOL_ID = 0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954;

    /// What the real contracts answer at the pinned block (P2-U0's measurements).
    uint256 internal constant PIN_TIME = 1_790_876_425;
    int256 internal constant MON_ANSWER = 3_436_820;
    uint256 internal constant MON_UPDATED = 1_790_876_421;
    int256 internal constant USDC_ANSWER = 99_999_000;
    uint256 internal constant USDC_UPDATED = 1_790_874_479;

    OracleAdapter internal adapter;

    function setUp() public {
        string memory url = vm.envOr("LOCAL_FORK_URL", string(""));
        if (bytes(vm.envOr("MONAD_RPC_URL", string(""))).length == 0 || bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        vm.rollFork(vm.parseJsonUint(vm.readFile("./fork.json"), ".blockNumber"));
        adapter = new OracleAdapter(
            OracleAdapter.Config({
                usdc: address(USDC),
                wmon: address(WMON),
                monUsdFeed: MON_USD,
                monUsdDecimals: 8,
                monUsdMaxAge: 300,
                usdcUsdFeed: USDC_USD,
                usdcUsdDecimals: 8,
                usdcUsdMaxAge: 7_200,
                stateView: STATE_VIEW,
                poolId: POOL_ID,
                maxDeviationBps: 200,
                maxDepegBps: 100
            })
        );
    }

    function unavailable(address asset, OracleReason reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IOracleAdapter.OracleUnavailable.selector, asset, reason);
    }

    function reasonOf(address asset) internal view returns (uint8) {
        (,, OracleReason r) = adapter.price(asset);
        return uint8(r);
    }

    /// Makes the real MON/USD answer `answer` now, as a new complete round.
    function mockMon(int256 answer) internal {
        vm.mockCall(
            address(MON_USD),
            abi.encodeCall(IChainlinkFeed.latestRoundData, ()),
            abi.encode(uint80(900), answer, block.timestamp, block.timestamp, uint80(900))
        );
    }

    // ----- the real feeds and pool -----

    function test_ReadsTheRealFeedsAtThePinnedBlock() public view {
        assertEq(block.timestamp, PIN_TIME);
        (uint256 p, uint256 at, OracleReason r) = adapter.price(address(WMON));
        assertEq(uint8(r), uint8(OracleReason.OK));
        assertEq(p, uint256(MON_ANSWER) * 1e10, "$0.0343682");
        assertEq(at, MON_UPDATED);
        (uint256 usdcUsd, uint256 usdcAt, OracleReason u) = adapter.usdcPeg();
        assertEq(uint8(u), uint8(OracleReason.OK));
        assertEq(usdcUsd, uint256(USDC_ANSWER) * 1e10, "0.99999");
        assertEq(usdcAt, USDC_UPDATED);
        assertEq(adapter.priceE18(address(USDC)), 1e18);
    }

    function test_TheRealPoolIsTwoBasisPointsFromTheOracle() public view {
        (uint256 pool, OracleReason r) = adapter.poolPrice(address(WMON));
        assertEq(uint8(r), uint8(OracleReason.OK));
        assertEq(pool, 34_376_116_674_083_669, "$0.0343761");
        (uint256 bps, OracleReason d) = adapter.poolDeviationBps(address(WMON));
        assertEq(bps, 2);
        assertEq(uint8(d), uint8(OracleReason.OK));
        assertEq(adapter.tradablePriceE18(address(WMON)), uint256(MON_ANSWER) * 1e10);
    }

    function test_TheRealFeedsGoStaleAtTheirBounds() public {
        vm.warp(MON_UPDATED + 299);
        assertEq(reasonOf(address(WMON)), uint8(OracleReason.OK));
        vm.warp(MON_UPDATED + 300);
        assertEq(reasonOf(address(WMON)), uint8(OracleReason.STALE));
        vm.expectRevert(unavailable(address(WMON), OracleReason.STALE));
        adapter.tradablePriceE18(address(WMON));
        vm.warp(USDC_UPDATED + 7_199);
        adapter.requireUsdcPeg();
        vm.warp(USDC_UPDATED + 7_200);
        vm.expectRevert(unavailable(address(USDC), OracleReason.STALE));
        adapter.requireUsdcPeg();
    }

    // ----- simulated failures of the real contracts -----

    function test_SimulatedInvalidAnswersFromTheRealFeed() public {
        mockMon(0);
        assertEq(reasonOf(address(WMON)), uint8(OracleReason.ANSWER_NOT_POSITIVE));
        mockMon(-3_436_820);
        assertEq(reasonOf(address(WMON)), uint8(OracleReason.ANSWER_NOT_POSITIVE));
        vm.mockCall(
            address(MON_USD),
            abi.encodeCall(IChainlinkFeed.latestRoundData, ()),
            abi.encode(uint80(900), MON_ANSWER, block.timestamp, block.timestamp, uint80(899))
        );
        assertEq(reasonOf(address(WMON)), uint8(OracleReason.ROUND_INCOMPLETE));
        vm.mockCall(
            address(MON_USD),
            abi.encodeCall(IChainlinkFeed.latestRoundData, ()),
            abi.encode(uint80(900), MON_ANSWER, block.timestamp, block.timestamp + 1, uint80(900))
        );
        assertEq(reasonOf(address(WMON)), uint8(OracleReason.FUTURE_TIMESTAMP));
        vm.mockCallRevert(address(MON_USD), abi.encodeCall(IChainlinkFeed.latestRoundData, ()), "down");
        assertEq(reasonOf(address(WMON)), uint8(OracleReason.FEED_REVERTED));
        vm.clearMockedCalls();
        vm.mockCall(address(MON_USD), abi.encodeCall(IChainlinkFeed.decimals, ()), abi.encode(uint8(18)));
        assertEq(reasonOf(address(WMON)), uint8(OracleReason.DECIMALS_MISMATCH));
        vm.clearMockedCalls();
        assertEq(reasonOf(address(WMON)), uint8(OracleReason.OK));
    }

    function test_ASimulatedUsdcDepegStopsOnlyDeposits() public {
        vm.mockCall(
            address(USDC_USD),
            abi.encodeCall(IChainlinkFeed.latestRoundData, ()),
            abi.encode(uint80(9), int256(98_000_000), block.timestamp, block.timestamp, uint80(9))
        );
        vm.expectRevert(unavailable(address(USDC), OracleReason.USDC_DEPEGGED));
        adapter.requireUsdcPeg();
        assertEq(adapter.priceE18(address(USDC)), 1e18);
        assertEq(adapter.tradablePriceE18(address(WMON)), uint256(MON_ANSWER) * 1e10);
    }

    function test_ASimulatedThreePercentPoolMoveBlocksTrades() public {
        (uint160 sqrt,,,) = STATE_VIEW.getSlot0(POOL_ID);
        // sqrt(1.03) × the real price: the pool 3% above where it was.
        uint160 moved = uint160(Math.mulDiv(sqrt, Math.sqrt(1.03e36), 1e18));
        vm.mockCall(
            address(STATE_VIEW),
            abi.encodeCall(IUniswapV4StateView.getSlot0, (POOL_ID)),
            abi.encode(moved, int24(0), uint24(0), uint24(500))
        );
        (bool ok, OracleReason r) = adapter.tradable(address(WMON));
        assertFalse(ok);
        assertEq(uint8(r), uint8(OracleReason.POOL_DEVIATION));
        assertEq(adapter.priceE18(address(WMON)), uint256(MON_ANSWER) * 1e10, "valuation is untouched");
    }

    // ----- a PersonalAccount with the real tokens and the real feeds -----

    /// The factory and its oracle set through the 9-day timelock, proposed 9
    /// days before the pinned block so the real feeds are fresh when it is used.
    function account() internal returns (PersonalAccount a, address owner) {
        owner = makeAddr("fork owner");
        MockAgentNFT nft = new MockAgentNFT();
        nft.setOwner(1, owner);
        address[] memory allow = new address[](1);
        allow[0] = owner;
        address admin = makeAddr("fork admin");
        vm.warp(PIN_TIME - 9 days);
        AccountFactory f = new AccountFactory(
            admin,
            makeAddr("guardian"),
            makeAddr("sentinel"),
            address(0),
            address(0),
            IAgentNFTView(address(nft)),
            address(USDC),
            address(WMON),
            100e6,
            2_000e6,
            allow
        );
        bytes32 value = bytes32(uint256(uint160(address(adapter))));
        vm.prank(admin);
        f.propose(AccountFactory.Action.SetOracle, value);
        vm.warp(PIN_TIME);
        f.execute(AccountFactory.Action.SetOracle, value);
        vm.prank(owner);
        a = PersonalAccount(f.createPersonalAccount(1));
    }

    function test_RealUsdcAndWmonDepositAtTheRealPrice_AndTheBreakerTrips() public {
        (PersonalAccount a, address owner) = account();
        vm.prank(USDC.masterMinter());
        USDC.configureMinter(address(this), 30e6);
        USDC.mint(owner, 30e6);
        vm.deal(owner, 1_100 ether);
        vm.startPrank(owner);
        WMON.deposit{value: 1_100 ether}();
        USDC.approve(address(a), 30e6);
        WMON.approve(address(a), 1_100 ether);
        a.deposit(address(USDC), 30e6);
        a.deposit(address(WMON), 1_100 ether);
        vm.stopPrank();

        // 1,100 WMON at $0.0343682 is 37.80502 USDC.
        uint256 wmonValue = 1_100 ether * uint256(MON_ANSWER) * 1e10 / 1e30;
        assertEq(wmonValue, 37_805_020);
        assertEq(a.principal(), 30e6 + wmonValue);
        assertEq(a.navUsdc(), 30e6 + wmonValue);
        (, uint256 perUnit, uint256 peak) = a.poke();
        assertEq(perUnit, 1e18);
        assertEq(peak, 1e18);

        // MON falls: the account is 56% WMON, so a 15% fall is an 8.4% drop.
        mockMon(MON_ANSWER * 85 / 100);
        a.poke();
        assertEq(uint8(a.mode()), uint8(AccountMode.NORMAL));
        mockMon(MON_ANSWER * 75 / 100);
        a.poke();
        assertEq(uint8(a.mode()), uint8(AccountMode.REDUCE_ONLY));
        mockMon(MON_ANSWER * 60 / 100);
        a.poke();
        assertEq(uint8(a.mode()), uint8(AccountMode.PAUSED));

        // Every feed down: the owner still withdraws the real tokens.
        vm.mockCallRevert(address(MON_USD), abi.encodeCall(IChainlinkFeed.latestRoundData, ()), "down");
        vm.mockCallRevert(address(USDC_USD), abi.encodeCall(IChainlinkFeed.latestRoundData, ()), "down");
        vm.prank(owner);
        a.withdrawAll(owner);
        assertEq(USDC.balanceOf(owner), 30e6);
        assertEq(WMON.balanceOf(owner), 1_100 ether);
        assertEq(a.units(), 0);
    }
}
