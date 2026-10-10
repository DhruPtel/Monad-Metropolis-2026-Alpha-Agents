// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {AccountFactoryV3} from "../../src/fund/AccountFactoryV3.sol";
import {ExecutorV3} from "../../src/fund/ExecutorV3.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {RouteAdapter} from "../../src/fund/RouteAdapter.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {IExecutorFactoryV3, PolicyV3, ReasonV3, SwapIntentV3} from "../../src/interfaces/IExecutorV3.sol";
import {
    FeedConfig,
    FeedLeg,
    IPoolRegistry,
    ITokenRegistry,
    PriceClass,
    PriceReason,
    Venue
} from "../../src/interfaces/IFund.sol";
import {IUniswapV4StateView} from "../../src/interfaces/IOracle.sol";
import {IPoolManager} from "../../src/interfaces/IUniswap.sol";
import {IUniswapV3PoolView} from "../../src/interfaces/IUniswapV3.sol";
import {ExecutorSetDeployer} from "../../script/ExecutorSetDeployer.sol";
import {MockAgentNFT} from "../mocks/CustodyMocks.sol";
import {IFiatToken} from "./CustodyFork.t.sol";

/// Executor v3 against Monad's real tokens, feeds and pools at the pinned
/// block (F-U4), deployed in the production order: the Executor, then its
/// RouteAdapter and the ProtocolRegistryV3 from one ExecutorSetDeployer so the
/// registry lists the adapter from its construction (D-363), the oracle, the
/// factory with the Executor given, and the binding. A session key then trades
/// a funded PersonalAccountV3 through one, two and three real pools, with
/// funds staying in the account, and the gas of each route is logged for
/// evidence/f-u4/GAS.md. Runs only on a fork named by LOCAL_FORK_URL (L-100).
contract ExecutorV3ForkTest is Test {
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

    bytes32 internal constant ROUTER = keccak256("route-adapter");
    uint256 internal constant AGENT = 1;

    TokenRegistry internal tokens;
    ProtocolRegistryV3 internal pools;
    OracleAdapterV3 internal oracle;
    RouteAdapter internal router;
    /// A second adapter with this test as its Executor, only to buy the owner's deposits.
    RouteAdapter internal funder;
    ExecutorV3 internal executor;
    AccountFactoryV3 internal factory;
    PersonalAccountV3 internal account;
    MockAgentNFT internal nft;
    address internal owner = makeAddr("fork owner");
    address internal admin = makeAddr("fork admin");
    address internal session = makeAddr("session key");
    uint256 internal actionCounter;

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
        seeds[6] = _seed(SHMON, monUsd, FeedLeg(0x2dC0b316e3d4e673C7F9A809e80a3e60b26d7774, 18, 90_000));
        tokens = new TokenRegistry(admin, admin, admin, seeds);
        nft = new MockAgentNFT();
        nft.setOwner(AGENT, owner);

        // 1. The Executor, with its registries bound later.
        executor = new ExecutorV3(
            admin, admin, IAgentNFTView(address(nft)), ITokenRegistry(address(tokens)), USDC, WMON, _launchPolicy()
        );

        // 2. The adapter and the registry from one deployer (D-363): the adapter needs the
        // registry's address, the registry pins the adapter's code, and both follow from the arguments.
        ProtocolRegistryV3.PoolSeed[] memory ps = new ProtocolRegistryV3.PoolSeed[](7);
        ps[0] = _v3(Venue.UNISWAP_V3, UNI_USDC_WMON_3000);
        ps[1] = _v3(Venue.PANCAKESWAP_V3, CAKE_USDC_WMON_500);
        ps[2] = _v3(Venue.PANCAKESWAP_V3, CAKE_CBBTC_WMON_500);
        ps[3] = _v3(Venue.UNISWAP_V3, UNI_SHMON_WMON_100);
        ps[4] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, address(0), USDC, 500, 10, address(0));
        ps[5] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, address(0), WBTC, 500, 1, address(0));
        ps[6] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, AUSD, USDC, 50, 1, address(0));
        ExecutorSetDeployer deployer = new ExecutorSetDeployer(
            ExecutorSetDeployer.Args({
                admin: admin,
                guardian: admin,
                screener: admin,
                tokens: ITokenRegistry(address(tokens)),
                venues: ProtocolRegistryV3.Venues({
                    uniswapV3Factory: UNI_FACTORY,
                    pancakeswapV3Factory: CAKE_FACTORY,
                    poolManager: POOL_MANAGER,
                    stateView: IUniswapV4StateView(STATE_VIEW),
                    wmon: WMON,
                    usdc: USDC
                }),
                pools: ps,
                adapterId: ROUTER,
                executor: address(executor),
                poolManager: POOL_MANAGER,
                wmon: WMON,
                usdc: USDC
            })
        );
        router = deployer.ROUTER();
        pools = deployer.REGISTRY();
        assertEq(pools.adapterFor(ROUTER), address(router), "the adapter is active from construction");
        assertEq(address(router.REGISTRY()), address(pools));
        idUniUsdcWmon = pools.poolIdOf(ps[0]);
        idCakeUsdcWmon = pools.poolIdOf(ps[1]);
        idCakeCbbtcWmon = pools.poolIdOf(ps[2]);
        idUniShmonWmon = pools.poolIdOf(ps[3]);
        idV4MonUsdc = pools.poolIdOf(ps[4]);
        idV4WbtcMon = pools.poolIdOf(ps[5]);
        idV4AusdUsdc = pools.poolIdOf(ps[6]);

        // 3. The oracle over the new registry, the factory with the Executor given, the binding.
        oracle = new OracleAdapterV3(
            ITokenRegistry(address(tokens)),
            IPoolRegistry(address(pools)),
            IUniswapV4StateView(STATE_VIEW),
            USDC,
            WMON,
            200
        );
        funder = new RouteAdapter(IPoolRegistry(address(pools)), IPoolManager(POOL_MANAGER), WMON, USDC, address(this));
        address[] memory allow = new address[](1);
        allow[0] = owner;
        factory = new AccountFactoryV3(
            AccountFactoryV3.Deployment({
                admin: admin,
                guardian: makeAddr("guardian"),
                sentinel: makeAddr("sentinel"),
                oracle: address(oracle),
                executor: address(executor),
                agentNft: IAgentNFTView(address(nft)),
                usdc: USDC,
                tokenRegistry: ITokenRegistry(address(tokens)),
                personalCap: 1_000e6,
                platformCap: 20_000e6,
                allowlist: allow
            })
        );
        vm.prank(admin);
        executor.bind(IExecutorFactoryV3(address(factory)), IPoolRegistry(address(pools)));

        // 4. The owner's account: 400 USDC, and 100 USDC each of WMON, cbBTC and WBTC bought through the real pools.
        vm.prank(owner);
        account = PersonalAccountV3(factory.createPersonalAccount(AGENT));
        _mintUsdc(owner, 400e6);
        _deposit(USDC, 400e6);
        _deposit(WMON, _buy(WMON, owner, 100e6));
        _deposit(CBBTC, _buy(CBBTC, owner, 100e6));
        _deposit(WBTC, _buy(WBTC, owner, 100e6));
        vm.prank(owner);
        executor.registerSession(AGENT, session, uint64(block.timestamp + 7 days));
    }

    // ----- helpers -----

    function _launchPolicy() internal pure returns (PolicyV3 memory) {
        return PolicyV3({
            maxTradeBps: 1_000,
            maxAssetBps: 4_000,
            minUsdcBps: 1_000,
            maxSlippageBps: 50,
            maxSlippageClassABps: 100,
            maxClassAPositionBps: 1_500,
            maxClassATotalBps: 5_000,
            maxTurnoverBps: 10_000,
            maxTradesPerWindow: 20,
            windowSeconds: 86_400,
            deadlineSeconds: 120
        });
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

    function _mintUsdc(address to, uint256 amount) internal {
        IFiatToken usdc = IFiatToken(USDC);
        vm.prank(usdc.masterMinter());
        usdc.configureMinter(address(this), amount);
        usdc.mint(to, amount);
    }

    /// Buys `token` for `to` with `usdcIn` through its real pools, this test being the funder's Executor.
    function _buy(address token, address to, uint256 usdcIn) internal returns (uint256 got) {
        _mintUsdc(address(this), usdcIn);
        IERC20(USDC).transfer(address(funder), usdcIn);
        bytes32[] memory r;
        if (token == WMON) {
            r = new bytes32[](1);
            r[0] = idCakeUsdcWmon;
        } else {
            r = new bytes32[](2);
            r[0] = idCakeUsdcWmon;
            r[1] = token == WBTC ? idV4WbtcMon : idCakeCbbtcWmon;
        }
        got = funder.swapRoute(USDC, token, usdcIn, 1, to, r, false);
        assertGt(got, 0, "bought");
    }

    function _deposit(address token, uint256 amount) internal {
        vm.startPrank(owner);
        IERC20(token).approve(address(account), amount);
        account.deposit(token, amount);
        vm.stopPrank();
    }

    /// The USDC value of an amount at the oracle.
    function _value(address token, uint256 amount) internal view returns (uint256) {
        (uint256 p,, PriceReason r) = oracle.price(token);
        assertEq(uint8(r), uint8(PriceReason.OK), "priced");
        return amount * p / (10 ** uint256(tokens.tokenRecord(token).decimals)) / 1e12;
    }

    function _decimals(address token) internal view returns (uint8) {
        return tokens.tokenRecord(token).decimals;
    }

    /// The amount of `token` worth `valueE6` at the oracle.
    function _amountFor(address token, uint256 valueE6) internal view returns (uint256) {
        if (token == USDC) return valueE6;
        (uint256 p,,) = oracle.price(token);
        return valueE6 * (10 ** (uint256(_decimals(token)) + 12)) / p;
    }

    /// A valid intent at the floor the Executor computes from the feeds.
    function _intent(address tokenIn, address tokenOut, uint256 amountIn, bytes32[] memory route)
        internal
        returns (SwapIntentV3 memory i)
    {
        (uint256 pxIn,,) = oracle.price(tokenIn);
        (uint256 pxOut,,) = oracle.price(tokenOut);
        uint256 floor = executor.floorFor(amountIn, pxIn, _decimals(tokenIn), pxOut, _decimals(tokenOut), 50);
        i = SwapIntentV3({
            schemaVersion: 2,
            chainId: block.chainid,
            agentId: AGENT,
            account: address(account),
            actionId: keccak256(abi.encode("fork action", ++actionCounter)),
            ownerEpoch: nft.ownerEpoch(AGENT),
            configEpoch: executor.configEpochOf(AGENT),
            policyHash: executor.policyHash(),
            adapterId: ROUTER,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: floor,
            deadline: uint64(block.timestamp + 120),
            route: route,
            attestationIn: "",
            attestationOut: ""
        });
    }

    /// Submits from the session key, measures the gas the Executor's swap used, and checks nothing stayed behind.
    function _swap(SwapIntentV3 memory i, string memory label) internal returns (uint256 out, uint256 gas) {
        uint256 outBefore = IERC20(i.tokenOut).balanceOf(address(account));
        uint256 inBefore = IERC20(i.tokenIn).balanceOf(address(account));
        vm.prank(session);
        gas = gasleft();
        out = executor.swap(i);
        gas -= gasleft();
        emit log_named_uint(label, gas);
        assertEq(IERC20(i.tokenOut).balanceOf(address(account)) - outBefore, out, "the output reached the account");
        assertEq(inBefore - IERC20(i.tokenIn).balanceOf(address(account)), i.amountIn, "exactly the input left");
        assertGe(out, i.minAmountOut, "at least the minimum");
        address[7] memory all = [USDC, WMON, WBTC, CBBTC, WETH, AUSD, SHMON];
        for (uint256 k = 0; k < all.length; ++k) {
            assertEq(IERC20(all[k]).balanceOf(address(executor)), 0, "the Executor keeps nothing");
            assertEq(IERC20(all[k]).balanceOf(address(router)), 0, "the adapter keeps nothing");
        }
        assertEq(address(executor).balance, 0);
        assertEq(address(router).balance, 0);
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

    // ----- tests -----

    function test_TheSetIsBoundAndTheTradedPoolsSitOnTheirFeeds() public {
        assertEq(address(executor.factory()), address(factory));
        assertEq(address(executor.pools()), address(pools));
        assertEq(factory.executor(), address(executor));
        assertEq(router.EXECUTOR(), address(executor));
        assertEq(address(router.REGISTRY()), address(pools));
        bytes32[7] memory used =
            [idUniUsdcWmon, idCakeUsdcWmon, idV4MonUsdc, idCakeCbbtcWmon, idV4AusdUsdc, idV4WbtcMon, idUniShmonWmon];
        address[7] memory priced = [WMON, WMON, WMON, CBBTC, AUSD, WBTC, SHMON];
        string[7] memory names;
        names[0] = "uni usdc/wmon 0.3%";
        names[1] = "cake usdc/wmon 0.05%";
        names[2] = "v4 mon/usdc 0.05%";
        names[3] = "cake cbbtc/wmon 0.05%";
        names[4] = "v4 ausd/usdc 0.005%";
        names[5] = "v4 wbtc/mon 0.05%";
        names[6] = "uni shmon/wmon 0.01%";
        for (uint256 k = 0; k < used.length; ++k) {
            (uint256 bps, PriceReason r) = oracle.poolDeviationBps(priced[k], used[k]);
            assertEq(uint8(r), uint8(PriceReason.OK), "pool priced");
            assertLt(bps, 200, "within 2% of the feed");
            // The pool's spot and the feed, so a route's favorable direction can be read (evidence/f-u4/GAS.md).
            (uint256 spot,) = oracle.poolPrice(priced[k], used[k]);
            (uint256 feed,,) = oracle.price(priced[k]);
            emit log_named_uint(string.concat(names[k], " spot"), spot);
            emit log_named_uint(string.concat(names[k], " feed"), feed);
        }
        assertGt(account.navUsdc(), 690e6);
        assertLt(account.navUsdc(), 710e6);
    }

    /// One hop: USDC to WMON through PancakeSwap v3's 0.05% pool.
    function test_AOneHopTradeSettlesOnTheRealPool() public {
        uint256 navBefore = account.navUsdc();
        SwapIntentV3 memory i = _intent(USDC, WMON, 20e6, _r(idCakeUsdcWmon));
        (uint256 out, uint256 gas) = _swap(i, "gas: swap, 1 hop (PancakeSwap v3)");
        assertGt(_value(WMON, out), 19_800_000, "within 1% of the feed's value");
        assertGt(account.navUsdc() + 200_000, navBefore, "the account lost under 0.2 USDC");
        assertLt(gas, 3_000_000);
    }

    /// Two hops: cbBTC to WMON to USDC, both on PancakeSwap v3. The direction
    /// matters on real pools: each pool may sit up to 2% from its feed, and a
    /// route's floor is 0.5% under the feeds, so the buy of cbBTC through the
    /// same two pools is refused at this block while the sale fills.
    function test_ATwoHopTradeSettlesAcrossTwoRealPools() public {
        uint256 amountIn = _amountFor(CBBTC, 20e6);
        SwapIntentV3 memory i = _intent(CBBTC, USDC, amountIn, _r(idCakeCbbtcWmon, idCakeUsdcWmon));
        (uint256 out, uint256 gas) = _swap(i, "gas: swap, 2 hops (PancakeSwap v3 x2)");
        assertGt(out, 19_800_000);
        assertLt(gas, 3_000_000);
        SwapIntentV3 memory back = _intent(USDC, CBBTC, 20e6, _r(idCakeUsdcWmon, idCakeCbbtcWmon));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.SLIPPAGE_TOO_HIGH));
        executor.swap(back);
    }

    /// Three hops: cbBTC to WMON (PancakeSwap v3) to USDC (PancakeSwap v3) to AUSD (Uniswap v4).
    function test_AThreeHopTradeSettlesAcrossBothV3VenuesAndV4() public {
        uint256 amountIn = _amountFor(CBBTC, 20e6);
        SwapIntentV3 memory i = _intent(CBBTC, AUSD, amountIn, _r(idCakeCbbtcWmon, idCakeUsdcWmon, idV4AusdUsdc));
        (uint256 out, uint256 gas) = _swap(i, "gas: swap, 3 hops (PancakeSwap v3 x2, Uniswap v4)");
        assertGt(_value(AUSD, out), 19_800_000);
        assertTrue(account.isHeld(AUSD), "AUSD joined the held list");
        assertLt(gas, 3_500_000);
    }

    /// A two-hop route through the native MON v4 pool: WBTC to MON on v4 (wrapped
    /// to WMON between hops), WMON to USDC on PancakeSwap v3.
    function test_ATwoHopTradeCrossesTheNativeMonV4PoolAndPancakeSwap() public {
        uint256 amountIn = _amountFor(WBTC, 20e6);
        SwapIntentV3 memory i = _intent(WBTC, USDC, amountIn, _r(idV4WbtcMon, idCakeUsdcWmon));
        (uint256 out, uint256 gas) = _swap(i, "gas: swap, 2 hops (native MON v4, PancakeSwap v3)");
        assertGt(out, 19_800_000, "0.05% fees twice and a little impact");
        assertLt(gas, 3_000_000);
    }

    /// The same limits hold on the real chain: size, a route of four hops, a stranger's key.
    function test_TheLimitsRefuseOnTheRealChainToo() public {
        SwapIntentV3 memory big = _intent(USDC, WMON, 100e6, _r(idCakeUsdcWmon));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.TRADE_SIZE_EXCEEDED));
        executor.swap(big);
        bytes32[] memory four = new bytes32[](4);
        (four[0], four[1], four[2], four[3]) = (idCakeUsdcWmon, idCakeCbbtcWmon, idCakeCbbtcWmon, idCakeUsdcWmon);
        SwapIntentV3 memory long = _intent(USDC, WMON, 20e6, four);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.ROUTE_INVALID));
        executor.swap(long);
        SwapIntentV3 memory ok = _intent(USDC, WMON, 20e6, _r(idCakeUsdcWmon));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.SESSION_UNKNOWN));
        executor.swap(ok);
    }
}
