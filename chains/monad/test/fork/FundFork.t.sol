// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {
    FeedConfig,
    FeedLeg,
    IPoolRegistry,
    ITokenRegistry,
    PriceClass,
    PriceReason,
    Venue
} from "../../src/interfaces/IFund.sol";
import {IPoolManager} from "../../src/interfaces/IUniswap.sol";
import {IUniswapV3PoolView} from "../../src/interfaces/IUniswapV3.sol";
import {IUniswapV4StateView} from "../../src/interfaces/IOracle.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {RouteAdapter} from "../../src/fund/RouteAdapter.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {IFiatToken} from "./CustodyFork.t.sol";

/// The fund agent's v3 set against Monad's real tokens, feeds and pools at
/// the pinned block (F-U2), with this test as the Executor: every core token
/// priced by its own feed and bound, and single-hop, two-hop and three-hop
/// routes settling through real Uniswap v3, PancakeSwap v3 and Uniswap v4
/// pools, with funds only ever returning to the account. Runs only on a fork
/// named by LOCAL_FORK_URL (L-100).
contract FundForkTest is Test {
    address internal constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address internal constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address internal constant WBTC = 0x0555E30da8f98308EdB960aa94C0Db47230d2B9c;
    address internal constant CBBTC = 0xd18B7EC58Cdf4876f6AFebd3Ed1730e4Ce10414b;
    address internal constant WETH = 0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242;
    address internal constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address internal constant SHMON = 0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c;

    address internal constant UNI_FACTORY = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address internal constant CAKE_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address internal constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address internal constant STATE_VIEW = 0x77395F3b2E73aE90843717371294fa97cC419D64;

    address internal constant UNI_USDC_WMON_3000 = 0x659bD0BC4167BA25c62E05656F78043E7eD4a9da;
    address internal constant CAKE_USDC_WMON_500 = 0x63e48B725540A3Db24ACF6682a29f877808C53F2;
    address internal constant CAKE_CBBTC_WMON_500 = 0x614B85502B89540Bb79bE98d5429EC032A78A284;
    address internal constant UNI_SHMON_WMON_100 = 0x1f86a9F2441caC9B942CFb5445530CdBB28717eD;

    TokenRegistry internal tokens;
    ProtocolRegistryV3 internal pools;
    OracleAdapterV3 internal oracle;
    RouteAdapter internal adapter;
    address internal account = makeAddr("account");

    bytes32 internal idUniUsdcWmon;
    bytes32 internal idCakeUsdcWmon;
    bytes32 internal idCakeCbbtcWmon;
    bytes32 internal idUniShmonWmon;
    bytes32 internal idV4MonUsdc;
    bytes32 internal idV4WbtcMon;
    bytes32 internal idV4AusdUsdc;

    function setUp() public {
        string memory url = vm.envOr("LOCAL_FORK_URL", string(""));
        if (bytes(vm.envOr("MONAD_RPC_URL", string(""))).length == 0 || bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        vm.rollFork(vm.parseJsonUint(vm.readFile("./fork.json"), ".blockNumber"));

        FeedLeg memory monUsd = FeedLeg(0xBcD78f76005B7515837af6b50c7C52BCf73822fb, 8, 300);
        FeedLeg memory none;
        TokenRegistry.CoreSeed[] memory seeds = new TokenRegistry.CoreSeed[](7);
        seeds[0] = _seed(USDC, FeedLeg(0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec, 8, 3_900), none);
        seeds[1] = _seed(WMON, monUsd, none);
        seeds[2] = _seed(WBTC, FeedLeg(0x2D1Df1bD061AAc38C22407AD69d69bCC3C62edBD, 8, 3_900), none);
        seeds[3] = _seed(CBBTC, FeedLeg(0x3dDc1bAE752aaEe31b577bF844c799C349A1d6BD, 8, 3_900), none);
        seeds[4] = _seed(WETH, FeedLeg(0x1B1414782B859871781bA3E4B0979b9ca57A0A04, 8, 3_900), none);
        seeds[5] = _seed(AUSD, FeedLeg(0xE20751C7B5867bCBef815ffc1b284c3f412a9e13, 8, 3_900), none);
        seeds[6] = _seed(SHMON, monUsd, FeedLeg(0x2dC0b316e3d4e673C7F9A809e80a3e60b26d7774, 18, 86_700));
        tokens = new TokenRegistry(address(this), address(this), address(this), seeds);

        ProtocolRegistryV3.PoolSeed[] memory ps = new ProtocolRegistryV3.PoolSeed[](7);
        ps[0] = _v3(Venue.UNISWAP_V3, UNI_USDC_WMON_3000);
        ps[1] = _v3(Venue.PANCAKESWAP_V3, CAKE_USDC_WMON_500);
        ps[2] = _v3(Venue.PANCAKESWAP_V3, CAKE_CBBTC_WMON_500);
        ps[3] = _v3(Venue.UNISWAP_V3, UNI_SHMON_WMON_100);
        ps[4] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, address(0), USDC, 500, 10, address(0));
        ps[5] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, address(0), WBTC, 500, 1, address(0));
        ps[6] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, AUSD, USDC, 50, 1, address(0));
        pools = new ProtocolRegistryV3(
            address(this),
            address(this),
            address(this),
            ITokenRegistry(address(tokens)),
            ProtocolRegistryV3.Venues({
                uniswapV3Factory: UNI_FACTORY,
                pancakeswapV3Factory: CAKE_FACTORY,
                poolManager: POOL_MANAGER,
                stateView: IUniswapV4StateView(STATE_VIEW),
                wmon: WMON,
                usdc: USDC
            }),
            ps,
            new bytes32[](0),
            new address[](0)
        );
        idUniUsdcWmon = pools.poolIdOf(ps[0]);
        idCakeUsdcWmon = pools.poolIdOf(ps[1]);
        idCakeCbbtcWmon = pools.poolIdOf(ps[2]);
        idUniShmonWmon = pools.poolIdOf(ps[3]);
        idV4MonUsdc = pools.poolIdOf(ps[4]);
        idV4WbtcMon = pools.poolIdOf(ps[5]);
        idV4AusdUsdc = pools.poolIdOf(ps[6]);

        oracle = new OracleAdapterV3(
            ITokenRegistry(address(tokens)),
            IPoolRegistry(address(pools)),
            IUniswapV4StateView(STATE_VIEW),
            USDC,
            WMON,
            200
        );
        adapter = new RouteAdapter(IPoolRegistry(address(pools)), IPoolManager(POOL_MANAGER), WMON, USDC, address(this));
    }

    function _seed(address token, FeedLeg memory usd, FeedLeg memory rate)
        internal
        pure
        returns (TokenRegistry.CoreSeed memory)
    {
        return TokenRegistry.CoreSeed(token, PriceClass.F, 4_500, FeedConfig(usd, rate));
    }

    function _v3(Venue venue, address pool) internal view returns (ProtocolRegistryV3.PoolSeed memory) {
        IUniswapV3PoolView p = IUniswapV3PoolView(pool);
        return ProtocolRegistryV3.PoolSeed(venue, p.token0(), p.token1(), p.fee(), p.tickSpacing(), pool);
    }

    function _fundUsdc(address to, uint256 amount) internal {
        IFiatToken usdc = IFiatToken(USDC);
        vm.prank(usdc.masterMinter());
        usdc.configureMinter(address(this), amount);
        usdc.mint(to, amount);
    }

    /// The USDC value of an amount of a core token at the oracle price.
    function _value(address token, uint256 amount) internal view returns (uint256) {
        (uint256 p,, PriceReason r) = oracle.price(token);
        assertEq(uint8(r), uint8(PriceReason.OK), "priced");
        return amount * p / (10 ** uint256(tokens.tokenRecord(token).decimals)) / 1e12;
    }

    /// Runs a route as the Executor would, for `account`, and checks nothing stays behind.
    function _route(address tin, address tout, uint256 amount, bytes32[] memory r) internal returns (uint256 out) {
        IERC20(tin).transfer(address(adapter), amount);
        uint256 before = IERC20(tout).balanceOf(account);
        out = adapter.swapRoute(tin, tout, amount, 1, account, r, false);
        assertEq(IERC20(tout).balanceOf(account) - before, out, "the output reached the account");
        address[7] memory all = [USDC, WMON, WBTC, CBBTC, WETH, AUSD, SHMON];
        for (uint256 i = 0; i < all.length; ++i) {
            assertEq(IERC20(all[i]).balanceOf(address(adapter)), 0, "the adapter keeps nothing");
        }
        assertEq(address(adapter).balance, 0, "and no native MON");
    }

    function _r(bytes32 a) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](1);
        r[0] = a;
    }

    function _r(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](2);
        (r[0], r[1]) = (a, b);
    }

    function _r(bytes32 a, bytes32 b, bytes32 c) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function test_EveryCoreTokenIsPricedByItsOwnFeedAndBound() public view {
        address[7] memory all = [USDC, WMON, WBTC, CBBTC, WETH, AUSD, SHMON];
        for (uint256 i = 0; i < all.length; ++i) {
            (uint256 p,, PriceReason r) = oracle.price(all[i]);
            assertEq(uint8(r), uint8(PriceReason.OK));
            assertGt(p, 0);
        }
        // shMON is worth more than MON: its exchange rate times MON/USD.
        (uint256 mon,,) = oracle.price(WMON);
        (uint256 sh,,) = oracle.price(SHMON);
        assertGt(sh, mon);
    }

    function test_TheTradedPoolsAreWithinTwoPercentOfTheirFeeds() public view {
        (uint256 bps, PriceReason r) = oracle.poolDeviationBps(WMON, idUniUsdcWmon);
        assertEq(uint8(r), uint8(PriceReason.OK));
        assertLt(bps, 200);
        (, r) = oracle.poolDeviationBps(WMON, idV4MonUsdc);
        assertEq(uint8(r), uint8(PriceReason.OK));
        (, r) = oracle.poolDeviationBps(CBBTC, idCakeCbbtcWmon);
        assertEq(uint8(r), uint8(PriceReason.OK));
    }

    function test_ASingleHopSettlesThroughTheRealUniswapV3Pool() public {
        _fundUsdc(address(this), 50e6);
        uint256 out = _route(USDC, WMON, 50e6, _r(idUniUsdcWmon));
        // 0.3% fee and a little impact: within 2% of the feed's value.
        assertGt(_value(WMON, out), 49e6);
    }

    function test_ATwoHopRouteSettlesThroughPancakeSwapPools() public {
        _fundUsdc(address(this), 100e6);
        uint256 out = _route(USDC, CBBTC, 100e6, _r(idCakeUsdcWmon, idCakeCbbtcWmon));
        assertGt(_value(CBBTC, out), 97e6);
    }

    function test_ATwoHopRouteCrossesUniswapV3AndANativeMonV4Pool() public {
        _fundUsdc(address(this), 100e6);
        // USDC to WMON on Uniswap v3, then WMON to WBTC through the v4 pool that holds native MON.
        uint256 wbtc = _route(USDC, WBTC, 100e6, _r(idUniUsdcWmon, idV4WbtcMon));
        assertGt(_value(WBTC, wbtc), 97e6);
        // And back: WBTC to MON on v4 (wrapped to WMON between hops), WMON to USDC on PancakeSwap v3.
        vm.prank(account);
        IERC20(WBTC).transfer(address(this), wbtc);
        uint256 usdcBack = _route(WBTC, USDC, wbtc, _r(idV4WbtcMon, idCakeUsdcWmon));
        assertGt(usdcBack, 95e6, "the round trip lost under 5%");
    }

    function test_AThreeHopRouteSettlesAcrossV4AndBothV3Venues() public {
        _fundUsdc(address(this), 100e6);
        // USDC to AUSD (v4), so the route can start from AUSD.
        uint256 ausd = _route(USDC, AUSD, 100e6, _r(idV4AusdUsdc));
        vm.prank(account);
        IERC20(AUSD).transfer(address(this), ausd);
        // AUSD to USDC (v4), USDC to WMON (Uniswap v3), WMON to shMON (Uniswap v3 0.01%).
        uint256 sh = _route(AUSD, SHMON, ausd, _r(idV4AusdUsdc, idUniUsdcWmon, idUniShmonWmon));
        assertGt(_value(SHMON, sh), 96e6);
    }

    function test_ASellOnlyTokenAndAPausedPoolAreSeenAtOnce() public {
        tokens.setSellOnly(WBTC);
        assertFalse(tokens.buyableFor(WBTC, account));
        assertTrue(tokens.sellable(WBTC));
        pools.pausePool(idV4WbtcMon);
        _fundUsdc(address(this), 10e6);
        IERC20(USDC).transfer(address(adapter), 10e6);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistryV3.PoolUnusable.selector, idV4WbtcMon));
        adapter.swapRoute(USDC, WBTC, 10e6, 1, account, _r(idUniUsdcWmon, idV4WbtcMon), false);
    }
}
