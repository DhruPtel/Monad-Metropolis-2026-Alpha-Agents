// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {RiskTimelock} from "../../src/executor/RiskTimelock.sol";
import {PolicyV3, ReasonV3, SwapIntentV3} from "../../src/interfaces/IExecutorV3.sol";
import {Venue} from "../../src/interfaces/IFund.sol";
import {PoolKey} from "../../src/interfaces/IUniswap.sol";
import {MockRouteAdapter} from "../mocks/ExecutorV3Mocks.sol";
import {ExecutorV3Base} from "./ExecutorV3Base.sol";

/// Routes, venues and the token rules (F-U4): what a route must be, which
/// pools and adapters it may use, screened tokens only for opted-in accounts,
/// sell-only tokens only sold, frozen tokens neither, and class A tokens
/// refused until the attestor exists, then traded on fresh attestations within
/// the cost-basis caps.
contract ExecutorV3TokensTest is ExecutorV3Base {
    // ----- routes -----

    function test_ARouteMustConnectTheTokensThroughRegisteredPools() public {
        expectRejected(intentWith(address(usdc), address(wmon), 10e6, 1, _route(idAWmon)), ReasonV3.ROUTE_INVALID);
        expectRejected(intentWith(address(usdc), address(tokA), 10e6, 1, _route(idUsdcWmon)), ReasonV3.ROUTE_INVALID);
        expectRejected(
            intentWith(address(usdc), address(wmon), 10e6, 1, _route(idUsdcWmon, idUsdcWmon)), ReasonV3.ROUTE_INVALID
        );
        expectRejected(intentWith(address(usdc), address(wmon), 10e6, 1, new bytes32[](0)), ReasonV3.ROUTE_INVALID);
        bytes32[] memory four = new bytes32[](4);
        four[0] = idUsdcWmon;
        four[1] = idAWmon;
        four[2] = idAWmon;
        four[3] = idUsdcWmon;
        expectRejected(intentWith(address(usdc), address(usdc), 10e6, 1, four), ReasonV3.INTENT_INVALID);
        expectRejected(intentWith(address(usdc), address(tokA), 10e6, 1, four), ReasonV3.ROUTE_INVALID);
        expectRejected(
            intentWith(address(usdc), address(wmon), 10e6, 1, _route(keccak256("not a pool"))),
            ReasonV3.VENUE_NOT_ALLOWED
        );
    }

    function test_AnIntermediateClassATokenIsRefused() public {
        setAttestor();
        optIn();
        // A screened C/D pool, so a route could pass through C.
        (address c0, address c1) = _sorted(address(tokC), address(tokD));
        PoolKey memory key = PoolKey(c0, c1, 500, 10, address(0));
        bytes32 id = keccak256(abi.encode(key));
        // 1 C (1e18) = 0.2 D (0.2e6).
        if (c0 == address(tokC)) {
            manager.setPrice(key, 2e5, 1e18);
            stateView.setSqrt(id, _sqrtX96(2e5, 1e18));
        } else {
            manager.setPrice(key, 1e18, 2e5);
            stateView.setSqrt(id, _sqrtX96(1e18, 2e5));
        }
        vm.prank(SCREENER);
        pools.addScreenedPool(ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, c0, c1, 500, 10, address(0)));
        SwapIntentV3 memory i = intentWith(address(usdc), address(tokD), 10e6, 1, _route(idUsdcWmon, idMonC, id));
        attest(i);
        expectRejected(i, ReasonV3.ROUTE_INVALID);
    }

    // ----- venues and pools -----

    function test_AnUnknownOrPausedVenueIsRefused() public {
        SwapIntentV3 memory i = buy(10e6);
        i.adapterId = keccak256("unknown");
        expectRejected(i, ReasonV3.VENUE_NOT_ALLOWED);
        vm.prank(guardian);
        pools.pauseAdapter(ROUTER);
        expectRejected(buy(10e6), ReasonV3.VENUE_NOT_ALLOWED);
    }

    function test_AVenueWhoseCodeChangedIsRefused() public {
        vm.etch(address(router), hex"fe");
        expectRejected(buy(10e6), ReasonV3.VENUE_NOT_ALLOWED);
    }

    function test_APausedPoolIsRefused_AnExitOnlyPoolOnlyCarriesRoutesIntoUsdc() public {
        vm.prank(guardian);
        pools.setPoolExitOnly(idUsdcWmon);
        expectRejected(buy(10e6), ReasonV3.VENUE_NOT_ALLOWED);
        expectRejected(trade(address(usdc), address(tokA), 10e6), ReasonV3.VENUE_NOT_ALLOWED);
        submit(sell(5e18));
        vm.prank(guardian);
        pools.pausePool(idUsdcWmon);
        expectRejected(sell(5e18), ReasonV3.VENUE_NOT_ALLOWED);
    }

    function test_RegisteringOrActivatingAVenueWaitsTheTimelock() public {
        MockRouteAdapter other = new MockRouteAdapter(address(executor));
        bytes32 id = keccak256("other");
        uint8 add = pools.ADD_ADAPTER();
        uint8 act = pools.ACTIVATE_ADAPTER();
        vm.prank(admin);
        pools.propose(add, abi.encode(id, address(other)));
        vm.expectPartialRevert(RiskTimelock.TooEarly.selector);
        pools.execute(add, abi.encode(id, address(other)));
        SwapIntentV3 memory i = buy(10e6);
        i.adapterId = id;
        expectRejected(i, ReasonV3.VENUE_NOT_ALLOWED);
        vm.warp(block.timestamp + 9 days);
        pools.execute(add, abi.encode(id, address(other)));
        afterWarp();
        // Added, not active.
        i = buy(10e6);
        i.adapterId = id;
        expectRejected(i, ReasonV3.VENUE_NOT_ALLOWED);
        vm.prank(admin);
        pools.propose(act, abi.encode(id));
        vm.expectPartialRevert(RiskTimelock.TooEarly.selector);
        pools.execute(act, abi.encode(id));
    }

    // ----- token rules -----

    function test_ASellOnlyTokenIsOnlySold() public {
        deposit(address(tokA), 10e18);
        vm.prank(SCREENER);
        tokens.setSellOnly(address(tokA));
        expectRejected(trade(address(usdc), address(tokA), 10e6), ReasonV3.TOKEN_SELL_ONLY);
        expectRejected(trade(address(wmon), address(tokA), 5e18), ReasonV3.TOKEN_SELL_ONLY);
        submit(trade(address(tokA), address(usdc), 1e18));
        submit(trade(address(tokA), address(tokB), 1e18));
        assertEq(bal(address(tokA), address(account)), 8e18);
    }

    function test_AFrozenTokenNeitherBuysNorSells() public {
        deposit(address(tokA), 10e18);
        vm.prank(guardian);
        tokens.freeze(address(tokA));
        expectRejected(trade(address(usdc), address(tokA), 10e6), ReasonV3.TOKEN_FROZEN);
        expectRejected(trade(address(tokA), address(usdc), 1e18), ReasonV3.TOKEN_FROZEN);
        expectRejected(trade(address(tokA), address(tokB), 1e18), ReasonV3.TOKEN_FROZEN);
        // The owner still withdraws it in kind.
        vm.prank(owner);
        account.withdraw(address(tokA), 10e18, owner);
        assertEq(bal(address(tokA), owner), 10e18);
    }

    function test_AScreenedTokenNeedsTheOwnersOptIn() public {
        setAttestor();
        expectRejected(trade(address(usdc), address(tokD), 10e6), ReasonV3.NOT_OPTED_IN);
        optIn();
        assertEq(submit(trade(address(usdc), address(tokD), 10e6)), 5e6);
        assertEq(account.costBasis(address(tokD)), 10e6);
        vm.prank(owner);
        account.setScreenedOptIn(false);
        expectRejected(trade(address(usdc), address(tokD), 10e6), ReasonV3.NOT_OPTED_IN);
        // Opting out only stops buying (D-365): the held D still sells through its screened pool,
        // into USDC or on through a core pool, but not into another screened token.
        expectRejected(trade(address(tokD), address(tokE), 1e6), ReasonV3.NOT_OPTED_IN);
        assertEq(submit(trade(address(tokD), address(wmon), 1e6)), 1e18);
        assertEq(submit(trade(address(tokD), address(usdc), 2e6)), 4e6);
        // And the owner can still take the rest out in kind.
        vm.prank(owner);
        account.withdraw(address(tokD), 2e6, owner);
        assertEq(bal(address(tokD), owner), 2e6);
        assertFalse(account.isHeld(address(tokD)));
    }

    /// A sell-only token sells through its pools too, into USDC or another token (D-365).
    function test_ASellOnlyScreenedTokenStillSellsThroughItsPool() public {
        setAttestor();
        optIn();
        submit(trade(address(usdc), address(tokD), 10e6));
        vm.prank(SCREENER);
        tokens.setSellOnly(address(tokD));
        expectRejected(trade(address(usdc), address(tokD), 1e6), ReasonV3.TOKEN_SELL_ONLY);
        assertEq(submit(trade(address(tokD), address(usdc), 2e6)), 4e6);
        // And still after opting out: into USDC, or on through a core pool.
        vm.prank(owner);
        account.setScreenedOptIn(false);
        assertEq(submit(trade(address(tokD), address(wmon), 1e6)), 1e18);
        assertEq(submit(trade(address(tokD), address(usdc), 2e6)), 4e6);
        assertFalse(account.isHeld(address(tokD)));
    }

    // ----- class A -----

    function test_ClassAIsRefusedUntilTheAttestorExists() public {
        assertEq(tokens.verifier(), address(0));
        expectRejected(trade(address(usdc), address(tokC), 10e6), ReasonV3.ATTESTOR_UNAVAILABLE);
        SwapIntentV3 memory bare = intent(address(usdc), address(tokC), 10e6, 1);
        expectRejected(bare, ReasonV3.ATTESTOR_UNAVAILABLE);
        optIn();
        expectRejected(trade(address(usdc), address(tokD), 10e6), ReasonV3.ATTESTOR_UNAVAILABLE);
    }

    function test_ClassANeedsAFreshAttestationForTheToken() public {
        setAttestor();
        SwapIntentV3 memory i = intent(address(usdc), address(tokC), 10e6, floorFor(address(usdc), address(tokC), 10e6));
        expectRejected(i, ReasonV3.ATTESTATION_REQUIRED);
        // Expired.
        i.attestationOut = attestation(address(tokC), PX_C);
        attestor.set(address(tokC), PX_C, uint64(block.timestamp - 1));
        expectRejected(i, ReasonV3.ATTESTATION_INVALID);
        // For another token.
        i.attestationOut = attestation(address(tokD), PX_D);
        expectRejected(i, ReasonV3.ATTESTATION_INVALID);
        // A price the pool is more than 2% away from.
        i.attestationOut = attestation(address(tokC), 0.5e18);
        expectRejected(i, ReasonV3.ORACLE_POOL_DEVIATION);
        // Fresh, for C, on the pool's price.
        i.attestationOut = attestation(address(tokC), PX_C);
        assertEq(submit(i), 25e18);
        // Selling needs one too.
        SwapIntentV3 memory s =
            intent(address(tokC), address(usdc), 25e18, floorFor(address(tokC), address(usdc), 25e18));
        expectRejected(s, ReasonV3.ATTESTATION_REQUIRED);
        s.attestationIn = attestation(address(tokC), PX_C);
        assertEq(submit(s), 10e6);
        assertFalse(account.isHeld(address(tokC)));
    }

    function test_ClassAPositionCap_ExactlyFifteenPercentPasses_OneUnitMoreIsRefused() public {
        setAttestor();
        submit(trade(address(usdc), address(tokC), 100e6));
        submit(trade(address(usdc), address(tokC), 50e6));
        assertEq(account.costBasis(address(tokC)), 150e6, "15% of a 1,000 USDC basis");
        (, uint256 totalBasis, uint256 classABasis) = account.capValues();
        assertEq(totalBasis, 1_000e6);
        assertEq(classABasis, 150e6);
        expectRejected(trade(address(usdc), address(tokC), 1), ReasonV3.CLASS_A_POSITION_CAP);
        expectRejected(trade(address(usdc), address(tokC), 1e6), ReasonV3.CLASS_A_POSITION_CAP);
        // Selling some frees the room again.
        submit(trade(address(tokC), address(usdc), 25e18)); // 10 USDC of basis
        submit(trade(address(usdc), address(tokC), 10e6));
        assertEq(account.costBasis(address(tokC)), 150e6);
    }

    function test_ClassATotalCap_ExactlyTheCapPasses_OneUnitMoreIsRefused() public {
        PolicyV3 memory p = launchPolicy();
        p.maxClassATotalBps = 2_000;
        tighten(p);
        setAttestor();
        optIn();
        submit(trade(address(usdc), address(tokC), 100e6));
        submit(trade(address(usdc), address(tokD), 100e6)); // class A basis 200: exactly 20%
        (, uint256 totalBasis, uint256 classABasis) = account.capValues();
        assertEq(totalBasis, 1_000e6);
        assertEq(classABasis, 200e6);
        // 0.001 USDC more (one unit of USDC buys less than one unit of D).
        expectRejected(trade(address(usdc), address(tokD), 1e3), ReasonV3.CLASS_A_TOTAL_CAP);
        // A swap between two class A tokens moves basis without adding to the total.
        submit(trade(address(tokD), address(tokC), 5e6));
        (,, classABasis) = account.capValues();
        assertEq(classABasis, 200e6);
        assertEq(account.costBasis(address(tokC)), 110e6);
        assertEq(account.costBasis(address(tokD)), 90e6);
    }

    function test_TheRegistrysCapBindsAClassAPositionToo() public {
        setAttestor();
        vm.prank(SCREENER);
        tokens.lowerCap(address(tokC), 1_000);
        submit(trade(address(usdc), address(tokC), 100e6));
        expectRejected(trade(address(usdc), address(tokC), 1), ReasonV3.CLASS_A_POSITION_CAP);
    }
}
