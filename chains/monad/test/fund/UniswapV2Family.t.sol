// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {QuoteOracleV3} from "../../src/fund/QuoteOracleV3.sol";
import {RouteAdapter} from "../../src/fund/RouteAdapter.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {
    FeedConfig,
    FeedLeg,
    IPoolRegistry,
    ITokenRegistry,
    PoolRecord,
    PriceClass,
    PriceReason,
    Venue
} from "../../src/interfaces/IFund.sol";
import {IPoolManager} from "../../src/interfaces/IUniswap.sol";
import {IUniswapV4StateView} from "../../src/interfaces/IOracle.sol";
import {MockToken} from "../mocks/CustodyMocks.sol";
import {MockPoolManager, MockStateViewAny, MockV3Factory, MockWMON} from "../mocks/FundMocks.sol";
import {FeeOnTransferToken, MockV2Factory, MockV2Pair} from "../mocks/V2Mocks.sol";

/// The Uniswap v2 family venue (2026-10-16): any v2 fork whose factory the
/// registry lists, by configuration, each pair with its own fee; the testnet
/// price mode that prices a token by its own pair; and the custody cap a dev
/// deploy may raise to 100%. USDC 6 decimals, WMON and TOK 18. Pairs:
/// WMON/USDC at 0.25% (1 WMON = 0.025 USDC), TOK/WMON at 1.6% (1 TOK = 4 WMON).
contract UniswapV2FamilyTest is Test {
    address internal constant ADMIN = address(0xA11CE);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant SCREENER = address(0x5C2E);

    MockToken internal usdc;
    MockWMON internal wmon;
    MockToken internal tok;
    MockV2Factory internal nadFactory;
    MockV2Factory internal otherFactory;
    MockV2Pair internal wmonUsdc;
    MockV2Pair internal tokWmon;
    TokenRegistry internal tokens;
    ProtocolRegistryV3 internal pools;
    QuoteOracleV3 internal oracle;
    RouteAdapter internal adapter;
    bytes32 internal idWmonUsdc;
    bytes32 internal idTokWmon;

    function setUp() public {
        vm.warp(1_790_876_425);
        usdc = new MockToken("USDC", 6);
        wmon = new MockWMON();
        tok = new MockToken("TOK", 18);
        nadFactory = new MockV2Factory();
        otherFactory = new MockV2Factory();
        wmonUsdc = MockV2Pair(nadFactory.createPair(address(wmon), address(usdc), 2_500));
        tokWmon = MockV2Pair(nadFactory.createPair(address(tok), address(wmon), 16_000));
        // 153,421 WMON against 3,836 USDC; 10,000 TOK against 40,000 WMON.
        _fill(wmonUsdc, address(wmon), 153_421e18, address(usdc), 3_836e6);
        _fill(tokWmon, address(tok), 10_000e18, address(wmon), 40_000e18);

        // Each class F token's "feed" names its pricing pair (the testnet price mode).
        TokenRegistry.CoreSeed[] memory seeds = new TokenRegistry.CoreSeed[](3);
        seeds[0] = _seed(address(usdc), address(wmonUsdc));
        seeds[1] = _seed(address(wmon), address(wmonUsdc));
        seeds[2] = _seed(address(tok), address(tokWmon));
        tokens = new TokenRegistry(ADMIN, GUARDIAN, SCREENER, seeds);

        address[] memory v2 = new address[](1);
        v2[0] = address(nadFactory);
        ProtocolRegistryV3.PoolSeed[] memory ps = new ProtocolRegistryV3.PoolSeed[](2);
        ps[0] = _v2Seed(wmonUsdc, 2_500);
        ps[1] = _v2Seed(tokWmon, 16_000);
        pools = new ProtocolRegistryV3(
            ADMIN,
            GUARDIAN,
            SCREENER,
            ITokenRegistry(address(tokens)),
            ProtocolRegistryV3.Venues({
                uniswapV3Factory: address(new MockV3Factory()),
                pancakeswapV3Factory: address(new MockV3Factory()),
                poolManager: address(new MockPoolManager()),
                stateView: IUniswapV4StateView(address(new MockStateViewAny())),
                wmon: address(wmon),
                usdc: address(usdc),
                v2Factories: v2
            }),
            ps,
            new bytes32[](0),
            new address[](0)
        );
        idWmonUsdc = bytes32(uint256(uint160(address(wmonUsdc))));
        idTokWmon = bytes32(uint256(uint160(address(tokWmon))));
        oracle = new QuoteOracleV3(
            ITokenRegistry(address(tokens)),
            IPoolRegistry(address(pools)),
            IUniswapV4StateView(address(pools.STATE_VIEW())),
            address(usdc),
            address(wmon),
            1_000
        );
        adapter = new RouteAdapter(
            IPoolRegistry(address(pools)),
            IPoolManager(pools.POOL_MANAGER()),
            address(wmon),
            address(usdc),
            address(this)
        );
    }

    // ---------------------------------------------------------------------
    // The registry
    // ---------------------------------------------------------------------

    function test_ListsAPairOfAListedV2FactoryWithItsOwnFee() public view {
        PoolRecord memory r = pools.pool(idTokWmon);
        assertEq(uint8(r.venue), uint8(Venue.UNISWAP_V2));
        assertEq(r.fee, 16_000);
        assertEq(r.pool, address(tokWmon));
        assertEq(r.codeHash, address(tokWmon).codehash);
        assertEq(pools.v2FactoryCount(), 1);
        assertEq(pools.v2FactoryHash(address(nadFactory)), address(nadFactory).codehash);
        pools.usablePool(idTokWmon, false, false);
    }

    function test_RefusesAPairOfAnUnlistedFactoryOrOneItsFactoryDoesNotReturn() public {
        MockV2Pair stray = MockV2Pair(otherFactory.createPair(address(tok), address(usdc), 3_000));
        bytes32 id = bytes32(uint256(uint160(address(stray))));
        ProtocolRegistryV3.PoolSeed memory s = _v2Seed(stray, 3_000);
        vm.prank(SCREENER);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistryV3.NotAPool.selector, id));
        pools.addScreenedPool(s);
    }

    function test_RefusesAV2FeeOutOfBoundsOrATickSpacing() public {
        MockV2Pair p = MockV2Pair(nadFactory.createPair(address(tok), address(usdc), 3_000));
        ProtocolRegistryV3.PoolSeed memory s = _v2Seed(p, 0);
        vm.startPrank(SCREENER);
        vm.expectRevert(ProtocolRegistryV3.BadPayload.selector);
        pools.addScreenedPool(s);
        s.fee = 100_000;
        vm.expectRevert(ProtocolRegistryV3.BadPayload.selector);
        pools.addScreenedPool(s);
        s.fee = 3_000;
        s.tickSpacing = 60;
        vm.expectRevert(ProtocolRegistryV3.BadPayload.selector);
        pools.addScreenedPool(s);
        vm.stopPrank();
    }

    function test_AddsAnotherV2ForkByConfigurationThroughTheTimelock() public {
        bytes memory data = abi.encode(address(otherFactory));
        uint8 action = pools.ADD_V2_FACTORY();
        vm.prank(ADMIN);
        pools.propose(action, data);
        vm.expectRevert();
        pools.execute(action, data);
        vm.warp(block.timestamp + pools.RISK_TIMELOCK() + 1);
        pools.execute(action, data);
        assertEq(pools.v2FactoryCount(), 2);
        MockV2Pair p = MockV2Pair(otherFactory.createPair(address(tok), address(usdc), 3_000));
        _fill(p, address(tok), 1_000e18, address(usdc), 100_000e6);
        ProtocolRegistryV3.PoolSeed memory s = _v2Seed(p, 3_000);
        vm.prank(SCREENER);
        bytes32 id = pools.addScreenedPool(s);
        assertEq(uint8(pools.pool(id).venue), uint8(Venue.UNISWAP_V2));
    }

    function test_FailsClosedWhenAFactorysCodeChanges() public {
        vm.etch(address(nadFactory), bytes(hex"6000"));
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistryV3.PoolUnusable.selector, idTokWmon));
        pools.usablePool(idTokWmon, false, false);
    }

    // ---------------------------------------------------------------------
    // The adapter
    // ---------------------------------------------------------------------

    function test_SwapsTwoV2HopsForExactlyWhatItQuotes() public {
        bytes32[] memory route = new bytes32[](2);
        route[0] = idWmonUsdc;
        route[1] = idTokWmon;
        uint256 amountIn = 10e6;
        uint256 quoted = adapter.quoteRoute(address(usdc), amountIn, route);
        // USDC to WMON at 0.25%, then WMON to TOK at 1.6%, by the v2 formula.
        uint256 wmonOut = _v2Out(amountIn, 3_836e6, 153_421e18, 2_500);
        uint256 expected = _v2Out(wmonOut, 40_000e18, 10_000e18, 16_000);
        assertEq(quoted, expected);
        usdc.mint(address(adapter), amountIn);
        address to = makeAddr("account");
        uint256 out = adapter.swapRoute(address(usdc), address(tok), amountIn, quoted, to, route, false);
        assertEq(out, quoted);
        assertEq(tok.balanceOf(to), quoted);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(wmon.balanceOf(address(adapter)), 0);
        // And back: TOK to WMON to USDC.
        bytes32[] memory back = new bytes32[](2);
        back[0] = idTokWmon;
        back[1] = idWmonUsdc;
        uint256 q2 = adapter.quoteRoute(address(tok), out, back);
        vm.prank(to);
        tok.transfer(address(adapter), out);
        assertEq(adapter.swapRoute(address(tok), address(usdc), out, q2, to, back, false), q2);
    }

    function test_RefusesATokenThatTakesAFeeOnTransfer() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        MockV2Pair p = MockV2Pair(nadFactory.createPair(address(fot), address(usdc), 3_000));
        fot.mint(address(p), 1_000e18);
        usdc.mint(address(p), 1_000e6);
        p.sync();
        vm.prank(ADMIN);
        tokens.propose(1, abi.encode(_seed(address(fot), address(p))));
        vm.warp(block.timestamp + tokens.RISK_TIMELOCK() + 1);
        tokens.execute(1, abi.encode(_seed(address(fot), address(p))));
        ProtocolRegistryV3.PoolSeed memory s = _v2Seed(p, 3_000);
        vm.prank(SCREENER);
        bytes32 id = pools.addScreenedPool(s);
        bytes32[] memory route = new bytes32[](1);
        route[0] = id;
        fot.mint(address(adapter), 10e18);
        vm.expectRevert(abi.encodeWithSelector(RouteAdapter.V2InputShort.selector, 9.9e18, 10e18));
        adapter.swapRoute(address(fot), address(usdc), 10e18, 1, makeAddr("to"), route, true);
    }

    function test_AFeeRegisteredBelowThePairsOwnFailsAtThePair() public {
        MockV2Pair p = MockV2Pair(nadFactory.createPair(address(tok), address(usdc), 16_000));
        _fill(p, address(tok), 1_000e18, address(usdc), 100_000e6);
        ProtocolRegistryV3.PoolSeed memory s = _v2Seed(p, 3_000);
        vm.prank(SCREENER);
        bytes32 id = pools.addScreenedPool(s);
        bytes32[] memory route = new bytes32[](1);
        route[0] = id;
        usdc.mint(address(adapter), 100e6);
        vm.expectRevert(bytes("K"));
        adapter.swapRoute(address(usdc), address(tok), 100e6, 1, makeAddr("to"), route, true);
    }

    function test_QuotesV2HopsOnly() public {
        bytes32[] memory route = new bytes32[](1);
        route[0] = keccak256("not a v2 pool");
        vm.expectRevert(abi.encodeWithSelector(RouteAdapter.QuoteUnsupported.selector, 0));
        adapter.quoteRoute(address(usdc), 1e6, route);
    }

    // ---------------------------------------------------------------------
    // The testnet price mode
    // ---------------------------------------------------------------------

    function test_PricesEachTokenByItsOwnPairThroughWmonToUsdc() public view {
        assertTrue(oracle.quoteMode());
        (uint256 pWmon,, PriceReason r1) = oracle.price(address(wmon));
        assertEq(uint8(r1), uint8(PriceReason.OK));
        // 3,836 USDC / 153,421 WMON, in USDC per whole WMON, 18 decimals.
        assertEq(pWmon, uint256(3_836e6) * 1e18 * 1e18 / (153_421e18 * 1e6));
        (uint256 pTok, uint256 at, PriceReason r2) = oracle.price(address(tok));
        assertEq(uint8(r2), uint8(PriceReason.OK));
        assertEq(at, block.timestamp);
        // 4 WMON per TOK, at the WMON price (rounding within one wei per step).
        assertApproxEqAbs(pTok, pWmon * 4, 4);
        (uint256 pUsdc,,) = oracle.price(address(usdc));
        assertEq(pUsdc, 1e18);
        (uint256 bps, PriceReason r3) = oracle.poolDeviationBps(address(tok), idTokWmon);
        assertEq(bps, 0);
        assertEq(uint8(r3), uint8(PriceReason.OK));
    }

    function test_TheFeedOracleIsNotInQuoteMode() public {
        OracleAdapterV3 feeds = new OracleAdapterV3(
            ITokenRegistry(address(tokens)),
            IPoolRegistry(address(pools)),
            IUniswapV4StateView(address(pools.STATE_VIEW())),
            address(usdc),
            address(wmon),
            200
        );
        assertFalse(feeds.quoteMode());
    }

    // ---------------------------------------------------------------------
    // The custody cap
    // ---------------------------------------------------------------------

    function test_ACustodyCapUpTo100PercentForADevDeployOnly() public {
        PersonalAccountV3 wide =
            new PersonalAccountV3(IAgentNFTView(address(1)), address(usdc), ITokenRegistry(address(tokens)), 10_000);
        assertEq(wide.MAX_ASSET_BPS(), 10_000);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.BadAssetCap.selector, 0));
        new PersonalAccountV3(IAgentNFTView(address(1)), address(usdc), ITokenRegistry(address(tokens)), 0);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.BadAssetCap.selector, 10_001));
        new PersonalAccountV3(IAgentNFTView(address(1)), address(usdc), ITokenRegistry(address(tokens)), 10_001);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _fill(MockV2Pair p, address a, uint256 amountA, address b, uint256 amountB) internal {
        _give(a, address(p), amountA);
        _give(b, address(p), amountB);
        p.sync();
    }

    function _give(address token, address to, uint256 amount) internal {
        if (token == address(wmon)) {
            vm.deal(address(this), amount);
            wmon.deposit{value: amount}();
            wmon.transfer(to, amount);
        } else {
            MockToken(token).mint(to, amount);
        }
    }

    function _seed(address token, address pricingPair) internal pure returns (TokenRegistry.CoreSeed memory) {
        FeedLeg memory none;
        return TokenRegistry.CoreSeed(
            token, PriceClass.F, 10_000, FeedConfig(FeedLeg({feed: pricingPair, decimals: 18, maxAge: 1}), none)
        );
    }

    function _v2Seed(MockV2Pair p, uint24 fee) internal view returns (ProtocolRegistryV3.PoolSeed memory) {
        return ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V2, p.token0(), p.token1(), fee, 0, address(p));
    }

    function _v2Out(uint256 amountIn, uint256 rIn, uint256 rOut, uint256 feePpm) internal pure returns (uint256) {
        uint256 inAfterFee = amountIn * (1_000_000 - feePpm);
        return inAfterFee * rOut / (rIn * 1_000_000 + inAfterFee);
    }
}
