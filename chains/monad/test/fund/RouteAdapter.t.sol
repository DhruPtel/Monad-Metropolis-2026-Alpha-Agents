// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Venue} from "../../src/interfaces/IFund.sol";
import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {RouteAdapter} from "../../src/fund/RouteAdapter.sol";
import {FeeOnTransferToken, MockToken} from "../mocks/CustodyMocks.sol";
import {PoolKey} from "../../src/interfaces/IUniswap.sol";
import {MockV3Pool} from "../mocks/FundMocks.sol";
import {FundBase} from "./FundBase.sol";

/// A pool that, mid-swap, tries to run another route through the adapter.
contract ReentrantPool is MockV3Pool {
    RouteAdapter public target;
    bytes32 public routeId;

    constructor(address t0, address t1) MockV3Pool(t0, t1, 500, 10) {}

    function arm(RouteAdapter t, bytes32 id) external {
        target = t;
        routeId = id;
    }

    function swap(address, bool, int256, uint160, bytes calldata) external override returns (int256, int256) {
        bytes32[] memory r = new bytes32[](1);
        r[0] = routeId;
        target.swapRoute(token0, token1, 1, 0, address(this), r, true);
        return (0, 0);
    }
}

/// The generic route adapter on mock venues (F-U2): single and multi-hop
/// routes, every refusal, and funds that only ever reach the recipient.
contract RouteAdapterTest is FundBase {
    address internal constant ACCOUNT = address(0xACC7);

    /// Moves `amount` of `token` to the adapter, as the Executor does, and runs the route.
    function _swap(address tokenIn, address tokenOut, uint256 amount, bytes32[] memory route, bool screened)
        internal
        returns (uint256)
    {
        _give(tokenIn, address(adapter), amount);
        return adapter.swapRoute(tokenIn, tokenOut, amount, 0, ACCOUNT, route, screened);
    }

    function _give(address token, address to, uint256 amount) internal {
        if (token == address(wmon)) _wmonTo(to, amount);
        else MockToken(token).mint(to, amount);
    }

    function _assertAdapterEmpty() internal view {
        address[5] memory all = [address(usdc), address(wmon), address(tokA), address(tokB), address(tokC)];
        for (uint256 i = 0; i < all.length; ++i) {
            assertEq(IERC20(all[i]).balanceOf(address(adapter)), 0, "the adapter keeps nothing");
        }
        assertEq(address(adapter).balance, 0, "and no native MON");
    }

    // ---- single hops on each venue ----

    function test_SwapsOneHopOnUniswapV3ToTheRecipient() public {
        uint256 out = _swap(address(wmon), address(usdc), 1e18, _route(idUsdcWmon), false);
        assertEq(out, 2e6);
        assertEq(usdc.balanceOf(ACCOUNT), 2e6);
        _assertAdapterEmpty();
    }

    function test_SwapsOneHopOnPancakeSwapV3ThroughItsCallback() public {
        uint256 out = _swap(address(tokA), address(wmon), 1e18, _route(idAWmon), false);
        assertEq(out, 3e18);
        assertEq(wmon.balanceOf(ACCOUNT), 3e18);
        _assertAdapterEmpty();
    }

    function test_SwapsWmonThroughANativeMonV4PoolAndWrapsTheOutputBack() public {
        uint256 out = _swap(address(wmon), address(tokC), 1e18, _route(idMonC), false);
        assertEq(out, 5e18);
        assertEq(tokC.balanceOf(ACCOUNT), 5e18);
        uint256 back = _swap(address(tokC), address(wmon), 5e18, _route(idMonC), false);
        assertEq(back, 1e18);
        assertEq(wmon.balanceOf(ACCOUNT), 1e18, "MON paid by the pool arrives as WMON");
        _assertAdapterEmpty();
    }

    function test_SwapsAnErc20PairOnV4() public {
        uint256 out = _swap(address(usdc), address(tokB), 40e6, _route(idBUsdc), false);
        assertEq(out, 1e8);
        _assertAdapterEmpty();
    }

    // ---- multi-hop ----

    function test_SwapsATwoHopRouteAcrossTwoVenues() public {
        // A to WMON on PancakeSwap v3, WMON to USDC on Uniswap v3.
        uint256 out = _swap(address(tokA), address(usdc), 1e18, _route(idAWmon, idUsdcWmon), false);
        assertEq(out, 6e6);
        assertEq(usdc.balanceOf(ACCOUNT), 6e6);
        _assertAdapterEmpty();
    }

    function test_SwapsAThreeHopRouteThroughV3AndV4() public {
        // A to WMON (PancakeSwap v3), WMON to USDC (Uniswap v3), USDC to B (Uniswap v4).
        uint256 out = _swap(address(tokA), address(tokB), 20e18, _route(idAWmon, idUsdcWmon, idBUsdc), false);
        assertEq(out, 3e8, "20 A = 60 WMON = 120 USDC = 3 B");
        _assertAdapterEmpty();
    }

    function test_SwapsAcrossANativeMonHopInTheMiddle() public {
        // C to MON (v4, native), then WMON to USDC (v3): the MON is wrapped between hops.
        uint256 out = _swap(address(tokC), address(usdc), 5e18, _route(idMonC, idUsdcWmon), false);
        assertEq(out, 2e6);
        _assertAdapterEmpty();
    }

    // ---- refusals ----

    function test_RefusesMoreThanThreeHops() public {
        bytes32[] memory r = new bytes32[](4);
        _give(address(tokA), address(adapter), 1e18);
        vm.expectRevert(RouteAdapter.BadRoute.selector);
        adapter.swapRoute(address(tokA), address(usdc), 1e18, 0, ACCOUNT, r, false);
    }

    function test_RefusesAnEmptyRouteAndARouteToItself() public {
        vm.expectRevert(RouteAdapter.BadRoute.selector);
        adapter.swapRoute(address(tokA), address(usdc), 1, 0, ACCOUNT, new bytes32[](0), false);
        vm.expectRevert(RouteAdapter.BadRoute.selector);
        adapter.swapRoute(address(usdc), address(usdc), 1, 0, ACCOUNT, _route(idUsdcWmon), false);
    }

    function test_RefusesABrokenRoute() public {
        _give(address(tokA), address(adapter), 1e18);
        // A's first hop must touch A.
        vm.expectRevert(abi.encodeWithSelector(RouteAdapter.BrokenRoute.selector, uint256(0)));
        adapter.swapRoute(address(tokA), address(usdc), 1e18, 0, ACCOUNT, _route(idUsdcWmon), false);
        // The route must end in tokenOut.
        vm.expectRevert(abi.encodeWithSelector(RouteAdapter.BrokenRoute.selector, uint256(1)));
        adapter.swapRoute(address(tokA), address(usdc), 1e18, 0, ACCOUNT, _route(idAWmon), false);
    }

    function test_RefusesARouteThatRevisitsAToken() public {
        _give(address(wmon), address(adapter), 1e18);
        // WMON to USDC and straight back to WMON.
        vm.expectRevert(abi.encodeWithSelector(RouteAdapter.BrokenRoute.selector, uint256(1)));
        adapter.swapRoute(
            address(wmon), address(tokA), 1e18, 0, ACCOUNT, _route(idUsdcWmon, idUsdcWmon, idAWmon), false
        );
    }

    function test_OnlyTheExecutorSwaps() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(RouteAdapter.NotExecutor.selector, address(0xBAD)));
        adapter.swapRoute(address(wmon), address(usdc), 1, 0, ACCOUNT, _route(idUsdcWmon), false);
    }

    function test_RefusesAnInputThatWasNotTransferredFirst() public {
        vm.expectRevert(abi.encodeWithSelector(RouteAdapter.InputMissing.selector, uint256(0), uint256(1e18)));
        adapter.swapRoute(address(wmon), address(usdc), 1e18, 0, ACCOUNT, _route(idUsdcWmon), false);
    }

    function test_EnforcesTheMinimumOutput() public {
        _give(address(wmon), address(adapter), 1e18);
        vm.expectRevert(abi.encodeWithSelector(RouteAdapter.OutputTooLow.selector, uint256(2e6), uint256(2e6 + 1)));
        adapter.swapRoute(address(wmon), address(usdc), 1e18, 2e6 + 1, ACCOUNT, _route(idUsdcWmon), false);
    }

    function test_AScreenedPoolNeedsTheExecutorsPermission() public {
        MockToken meme = new MockToken("MEME", 18);
        vm.prank(SCREENER);
        tokens.addScreened(address(meme), 800, bytes32(0), uint64(block.timestamp));
        (address m0, address m1) = _sorted(address(meme), address(usdc));
        MockV3Pool p = new MockV3Pool(m0, m1, 10_000, 200);
        uniFactory.setPool(m0, m1, 10_000, address(p));
        vm.prank(SCREENER);
        bytes32 id =
            pools.addScreenedPool(ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V3, m0, m1, 10_000, 200, address(p)));
        meme.mint(address(p), 1e24);
        _give(address(usdc), address(adapter), 1e6);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistryV3.PoolUnusable.selector, id));
        adapter.swapRoute(address(usdc), address(meme), 1e6, 0, ACCOUNT, _route(id), false);
        assertGt(adapter.swapRoute(address(usdc), address(meme), 1e6, 0, ACCOUNT, _route(id), true), 0);
    }

    function test_AnExitOnlyPoolCarriesSalesIntoUsdcOnly() public {
        vm.prank(GUARDIAN);
        pools.setPoolExitOnly(idUsdcWmon);
        _give(address(usdc), address(adapter), 2e6);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistryV3.PoolUnusable.selector, idUsdcWmon));
        adapter.swapRoute(address(usdc), address(wmon), 2e6, 0, ACCOUNT, _route(idUsdcWmon), false);
        usdc.burn(address(adapter), 2e6);
        assertEq(_swap(address(wmon), address(usdc), 1e18, _route(idUsdcWmon), false), 2e6);
    }

    // ---- unspent input, donations, callbacks, approvals, reentrancy ----

    function test_InputAPoolLeftUnusedGoesBackToTheRecipient() public {
        poolUsdcWmon.setMode(MockV3Pool.Mode.HalfFill);
        uint256 out = _swap(address(wmon), address(usdc), 2e18, _route(idUsdcWmon), false);
        assertEq(out, 2e6, "half the input filled");
        assertEq(wmon.balanceOf(ACCOUNT), 1e18, "the other half returned");
        _assertAdapterEmpty();
    }

    function test_DustAStrangerSentStaysAndDoesNotBlockSwaps() public {
        usdc.mint(address(adapter), 7);
        _swap(address(wmon), address(usdc), 1e18, _route(idUsdcWmon), false);
        assertEq(usdc.balanceOf(ACCOUNT), 2e6, "the recipient gets the route's output, not the dust");
        assertEq(usdc.balanceOf(address(adapter)), 7);
    }

    function test_OnlyThePoolBeingSwappedMayCallBack() public {
        vm.prank(address(poolUsdcWmon));
        vm.expectRevert(abi.encodeWithSelector(RouteAdapter.NotActivePool.selector, address(poolUsdcWmon)));
        adapter.uniswapV3SwapCallback(1, 0, "");
        vm.expectRevert(abi.encodeWithSelector(RouteAdapter.NotActivePool.selector, address(this)));
        adapter.pancakeV3SwapCallback(1, 0, "");
        vm.expectRevert(abi.encodeWithSelector(RouteAdapter.NotPoolManager.selector, address(this)));
        adapter.unlockCallback("");
    }

    function test_NeverGivesAnApproval() public {
        _swap(address(tokA), address(tokB), 20e18, _route(idAWmon, idUsdcWmon, idBUsdc), false);
        address[3] memory spenders = [address(poolUsdcWmon), address(poolAWmon), address(manager)];
        address[5] memory all = [address(usdc), address(wmon), address(tokA), address(tokB), address(tokC)];
        for (uint256 i = 0; i < spenders.length; ++i) {
            for (uint256 j = 0; j < all.length; ++j) {
                assertEq(IERC20(all[j]).allowance(address(adapter), spenders[i]), 0);
            }
        }
    }

    function test_RefusesNativeMonFromStrangers() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(adapter).call{value: 1}("");
        assertFalse(ok);
    }

    function test_ARouteCannotReenterTheAdapter() public {
        // A hostile pool, listed through the timelock like any core pool, reenters mid-swap.
        (address t0, address t1) = _sorted(address(usdc), address(tokC));
        ReentrantPool bad = new ReentrantPool(t0, t1);
        uniFactory.setPool(t0, t1, 500, address(bad));
        ProtocolRegistryV3.PoolSeed memory s =
            ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V3, t0, t1, 500, 10, address(bad));
        uint8 add = pools.ADD_CORE_POOL();
        vm.prank(ADMIN);
        pools.propose(add, abi.encode(s));
        vm.warp(block.timestamp + 9 days);
        // Feeds age with the warp; the adapter reads none.
        pools.execute(add, abi.encode(s));
        bytes32 id = bytes32(uint256(uint160(address(bad))));
        bad.arm(adapter, id);
        _give(address(usdc), address(adapter), 1e6);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        adapter.swapRoute(address(usdc), address(tokC), 1e6, 0, ACCOUNT, _route(id), false);
    }

    function test_AFeeOnTransferTokenFailsAtTheV4SettleByName() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        vm.prank(SCREENER);
        tokens.addScreened(address(fot), 800, bytes32(0), uint64(block.timestamp));
        (address c0, address c1) = _sorted(address(fot), address(usdc));
        PoolKey memory key = PoolKey(c0, c1, 3_000, 60, address(0));
        manager.setPrice(key, 1, 1);
        bytes32 id = keccak256(abi.encode(key));
        stateView.setSqrt(id, uint160(2 ** 96));
        vm.prank(SCREENER);
        pools.addScreenedPool(ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, c0, c1, 3_000, 60, address(0)));
        fot.mint(address(adapter), 1e6);
        // The adapter holds 1e6; sending it to PoolManager loses 1%, so PoolManager counts less than owed.
        vm.expectRevert(abi.encodeWithSelector(RouteAdapter.SettledShort.selector, uint256(990_000), uint256(1e6)));
        adapter.swapRoute(address(fot), address(usdc), 1e6, 0, ACCOUNT, _route(id), true);
    }

    // ---- fuzz: funds reach the recipient and nowhere else ----

    function testFuzz_FundsOnlyEverReachTheRecipient(uint256 amount, uint8 which) public {
        amount = bound(amount, 1e6, 1e24);
        which = uint8(bound(which, 0, 3));
        bytes32[] memory r;
        address tin;
        address tout;
        if (which == 0) (tin, tout, r) = (address(wmon), address(usdc), _route(idUsdcWmon));
        else if (which == 1) (tin, tout, r) = (address(tokA), address(usdc), _route(idAWmon, idUsdcWmon));
        else if (which == 2) (tin, tout, r) = (address(tokC), address(usdc), _route(idMonC, idUsdcWmon));
        else (tin, tout, r) = (address(tokA), address(tokB), _route(idAWmon, idUsdcWmon, idBUsdc));
        uint256 before = IERC20(tout).balanceOf(ACCOUNT);
        uint256 spentBefore = IERC20(tin).balanceOf(ACCOUNT);
        uint256 out = _swap(tin, tout, amount, r, false);
        assertEq(IERC20(tout).balanceOf(ACCOUNT) - before, out, "the recipient got exactly the output");
        assertEq(IERC20(tin).balanceOf(ACCOUNT), spentBefore, "no input was refunded on a full fill");
        _assertAdapterEmpty();
    }
}
