// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Lane, PoolRecord, PoolStatus, Venue} from "../../src/interfaces/IFund.sol";
import {LaneRegistry} from "../../src/fund/LaneRegistry.sol";
import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {MockToken} from "../mocks/CustodyMocks.sol";
import {MockV3Pool} from "../mocks/FundMocks.sol";
import {FundBase} from "./FundBase.sol";

/// Pools per pair in two lanes, pinned by code hash, and adapters (F-U2, D-341, D-342).
contract ProtocolRegistryV3Test is FundBase {
    MockToken internal meme;
    MockV3Pool internal memePool;
    ProtocolRegistryV3.PoolSeed internal memeSeed;

    function setUp() public override {
        super.setUp();
        meme = new MockToken("MEME", 18);
        vm.prank(SCREENER);
        tokens.addScreened(address(meme), 800, bytes32(0), uint64(block.timestamp));
        (address m0, address m1) = _sorted(address(meme), address(usdc));
        memePool = new MockV3Pool(m0, m1, 10_000, 200);
        uniFactory.setPool(m0, m1, 10_000, address(memePool));
        memeSeed = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V3, m0, m1, 10_000, 200, address(memePool));
    }

    function test_SeedsCorePoolsCheckedAgainstTheirVenues() public view {
        assertEq(pools.poolCount(), 4);
        PoolRecord memory v3 = pools.pool(idUsdcWmon);
        assertEq(uint8(v3.lane), uint8(Lane.CORE));
        assertEq(uint8(v3.venue), uint8(Venue.UNISWAP_V3));
        assertEq(v3.codeHash, address(poolUsdcWmon).codehash);
        PoolRecord memory v4 = pools.pool(idMonC);
        assertEq(v4.token0, address(0), "native MON");
        assertEq(v4.codeHash, address(manager).codehash);
    }

    function test_TheScreenerAddsAScreenedPoolAtOnce() public {
        vm.prank(SCREENER);
        bytes32 id = pools.addScreenedPool(memeSeed);
        assertEq(id, bytes32(uint256(uint160(address(memePool)))));
        assertEq(uint8(pools.pool(id).lane), uint8(Lane.SCREENED));
    }

    function test_ACorePoolNeedsCoreTokens() public {
        // meme is screened: a core pool with it is refused, through the timelock too.
        uint8 addCore = pools.ADD_CORE_POOL();
        vm.prank(ADMIN);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistryV3.TokenNotListed.selector, address(meme)));
        pools.propose(addCore, abi.encode(memeSeed));
    }

    function test_APoolItsFactoryDoesNotReturnIsRefused() public {
        uniFactory.setPool(memeSeed.token0, memeSeed.token1, 10_000, address(0x1234));
        vm.prank(SCREENER);
        vm.expectRevert(
            abi.encodeWithSelector(ProtocolRegistryV3.NotAPool.selector, bytes32(uint256(uint160(address(memePool)))))
        );
        pools.addScreenedPool(memeSeed);
    }

    function test_AV4PoolMustBeHooklessAndInitialized() public {
        (address c0, address c1) = _sorted(address(meme), address(usdc));
        ProtocolRegistryV3.PoolSeed memory s =
            ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, c0, c1, 3_000, 60, address(0));
        bytes32 id = pools.poolIdOf(s);
        vm.prank(SCREENER);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistryV3.NotAPool.selector, id));
        pools.addScreenedPool(s);
        stateView.setSqrt(id, uint160(2 ** 96));
        vm.prank(SCREENER);
        assertEq(pools.addScreenedPool(s), id);
    }

    function test_ScreenedPoolsServeOnlyRoutesThatAllowThem() public {
        vm.prank(SCREENER);
        bytes32 id = pools.addScreenedPool(memeSeed);
        pools.usablePool(id, true, false);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistryV3.PoolUnusable.selector, id));
        pools.usablePool(id, false, false);
    }

    function test_AnExitOnlyPoolCarriesOnlyRoutesIntoUsdc() public {
        vm.prank(GUARDIAN);
        pools.setPoolExitOnly(idUsdcWmon);
        pools.usablePool(idUsdcWmon, false, true);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistryV3.PoolUnusable.selector, idUsdcWmon));
        pools.usablePool(idUsdcWmon, false, false);
    }

    function test_PausingIsInstantAndActivatingWaitsTheTimelock() public {
        vm.prank(SCREENER);
        pools.pausePool(idUsdcWmon);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistryV3.PoolUnusable.selector, idUsdcWmon));
        pools.usablePool(idUsdcWmon, false, true);
        // Paused to exit-only is a loosening: refused at once.
        vm.prank(GUARDIAN);
        vm.expectRevert(
            abi.encodeWithSelector(ProtocolRegistryV3.NotStricter.selector, PoolStatus.PAUSED, PoolStatus.EXIT_ONLY)
        );
        pools.setPoolExitOnly(idUsdcWmon);
        uint8 activate = pools.ACTIVATE_POOL();
        bytes memory data = abi.encode(idUsdcWmon);
        vm.prank(ADMIN);
        pools.propose(activate, data);
        vm.warp(block.timestamp + 9 days);
        pools.execute(activate, data);
        pools.usablePool(idUsdcWmon, false, false);
    }

    function test_AChangedPoolOrAnUpgradedVenueFailsClosed() public {
        vm.etch(address(poolUsdcWmon), address(memePool).code);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistryV3.PoolUnusable.selector, idUsdcWmon));
        pools.usablePool(idUsdcWmon, false, false);
        // v4 pools fail when PoolManager's code changes.
        vm.etch(address(manager), hex"00");
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistryV3.PoolUnusable.selector, idMonC));
        pools.usablePool(idMonC, false, false);
    }

    function test_AnUpgradedFactoryFailsItsPoolsClosed() public {
        vm.etch(address(cakeFactory), hex"6000");
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistryV3.PoolUnusable.selector, idAWmon));
        pools.usablePool(idAWmon, false, false);
    }

    function test_AdaptersArePinnedByCodeHashAndAddedThroughTheTimelock() public {
        uint8 add = pools.ADD_ADAPTER();
        bytes32 aid = keccak256("route.v1");
        bytes memory data = abi.encode(aid, address(adapter));
        vm.prank(ADMIN);
        pools.propose(add, data);
        vm.warp(block.timestamp + 9 days);
        pools.execute(add, data);
        assertEq(pools.adapterFor(aid), address(0), "added inactive");
        uint8 activate = pools.ACTIVATE_ADAPTER();
        vm.prank(ADMIN);
        pools.propose(activate, abi.encode(aid));
        vm.warp(block.timestamp + 9 days);
        pools.execute(activate, abi.encode(aid));
        assertEq(pools.adapterFor(aid), address(adapter));
        vm.etch(address(adapter), hex"00");
        assertEq(pools.adapterFor(aid), address(0), "a changed adapter fails closed");
    }

    function test_AStrangerCannotTightenOrAddScreenedPools() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(LaneRegistry.NotTightener.selector, address(0xBAD)));
        pools.pausePool(idUsdcWmon);
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(LaneRegistry.NotScreener.selector, address(0xBAD)));
        pools.addScreenedPool(memeSeed);
    }
}
