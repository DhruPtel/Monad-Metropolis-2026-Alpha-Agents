// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {AccountFactoryV3} from "../../src/fund/AccountFactoryV3.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {ExecutorV3} from "../../src/fund/ExecutorV3.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {RouteAdapter} from "../../src/fund/RouteAdapter.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {StrategyVaultV3} from "../../src/fund/StrategyVaultV3.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {ExecutorSetDeployer} from "../../script/ExecutorSetDeployer.sol";
import {AccountMode, IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
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
import {MockAgentNFT} from "../mocks/CustodyMocks.sol";
import {IFiatToken} from "./CustodyFork.t.sol";

/// P7-U3 on Monad's real tokens, feeds and pools at the pinned block (pnpm
/// test:fork): the whole v3 set deployed as on chain, the agent's vault created
/// through the factory, seeded by its leader and funded by two depositors, and
/// traded by the session key through the real Executor and the real pools into
/// Circle's USDC, WMON, WBTC, cbBTC, WETH, AUSD and shMON. Then the spikes: the
/// lockups hold; every holder leaves in kind with the oracle, the registries,
/// the factory, the Executor, the adapters, AgentNFT and the seven Chainlink
/// feeds all replaced by reverting code (M-13); the leader cannot extract
/// depositors' funds; a handover holds; the backstops hold on real fills; no
/// value moves between depositors through trades or flows; and the gas of each
/// exit over real tokens (M-31). Runs only on a fork named by LOCAL_FORK_URL (L-100).
contract StrategyVaultV3ForkTest is Test {
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
    address internal constant FEED_MON_USD = 0xBcD78f76005B7515837af6b50c7C52BCf73822fb;
    address internal constant FEED_USDC_USD = 0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec;
    address internal constant FEED_WBTC_USD = 0x2D1Df1bD061AAc38C22407AD69d69bCC3C62edBD;
    address internal constant FEED_CBBTC_USD = 0x3dDc1bAE752aaEe31b577bF844c799C349A1d6BD;
    address internal constant FEED_WETH_USD = 0x1B1414782B859871781bA3E4B0979b9ca57A0A04;
    address internal constant FEED_AUSD_USD = 0xE20751C7B5867bCBef815ffc1b284c3f412a9e13;
    address internal constant FEED_SHMON_RATE = 0x2dC0b316e3d4e673C7F9A809e80a3e60b26d7774;
    bytes32 internal constant ROUTER = keccak256("route-adapter");
    uint256 internal constant AGENT = 1;

    TokenRegistry internal tokens;
    ProtocolRegistryV3 internal pools;
    OracleAdapterV3 internal oracle;
    RouteAdapter internal router;
    ExecutorV3 internal executor;
    AccountFactoryV3 internal factory;
    StrategyVaultV3 internal sv;
    MockAgentNFT internal nft;
    address internal owner = makeAddr("fork leader");
    address internal alice = makeAddr("fork alice");
    address internal bob = makeAddr("fork bob");
    address internal buyer = makeAddr("fork buyer");
    address internal admin = makeAddr("fork admin");
    address internal guardian = makeAddr("fork guardian");
    address internal session = makeAddr("session key");
    uint256 internal actionCounter;
    bytes32 internal idUniUsdcWmon;
    bytes32 internal idCakeUsdcWmon;
    bytes32 internal idCakeCbbtcWmon;
    bytes32 internal idUniShmonWmon;
    bytes32 internal idV4MonUsdc;
    bytes32 internal idV4WbtcMon;
    bytes32 internal idV4WethMon;
    bytes32 internal idV4AusdUsdc;
    address[7] internal all = [USDC, WMON, WBTC, CBBTC, WETH, AUSD, SHMON];
    /// The tokens the setUp's buys landed in the vault.
    address[] internal bought;

    function setUp() public {
        string memory url = vm.envOr("LOCAL_FORK_URL", string(""));
        if (bytes(vm.envOr("MONAD_RPC_URL", string(""))).length == 0 || bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        vm.rollFork(vm.parseJsonUint(vm.readFile("./fork.json"), ".blockNumber"));
        FeedLeg memory monUsd = FeedLeg(FEED_MON_USD, 8, 300);
        FeedLeg memory none;
        TokenRegistry.CoreSeed[] memory seeds = new TokenRegistry.CoreSeed[](7);
        seeds[0] = _seed(USDC, FeedLeg(FEED_USDC_USD, 8, 3_900), none);
        seeds[1] = _seed(WMON, monUsd, none);
        seeds[2] = _seed(WBTC, FeedLeg(FEED_WBTC_USD, 8, 3_900), none);
        seeds[3] = _seed(CBBTC, FeedLeg(FEED_CBBTC_USD, 8, 3_900), none);
        seeds[4] = _seed(WETH, FeedLeg(FEED_WETH_USD, 8, 3_900), none);
        seeds[5] = _seed(AUSD, FeedLeg(FEED_AUSD_USD, 8, 3_900), none);
        seeds[6] = _seed(SHMON, monUsd, FeedLeg(FEED_SHMON_RATE, 18, 90_000));
        tokens = new TokenRegistry(admin, admin, admin, seeds);
        nft = new MockAgentNFT();
        nft.setOwner(AGENT, owner);
        executor = new ExecutorV3(
            admin, admin, IAgentNFTView(address(nft)), ITokenRegistry(address(tokens)), USDC, WMON, _launchPolicy()
        );
        ProtocolRegistryV3.PoolSeed[] memory ps = new ProtocolRegistryV3.PoolSeed[](8);
        ps[0] = _v3(Venue.UNISWAP_V3, UNI_USDC_WMON_3000);
        ps[1] = _v3(Venue.PANCAKESWAP_V3, CAKE_USDC_WMON_500);
        ps[2] = _v3(Venue.PANCAKESWAP_V3, CAKE_CBBTC_WMON_500);
        ps[3] = _v3(Venue.UNISWAP_V3, UNI_SHMON_WMON_100);
        ps[4] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, address(0), USDC, 500, 10, address(0));
        ps[5] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, address(0), WBTC, 500, 1, address(0));
        ps[6] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, address(0), WETH, 500, 1, address(0));
        ps[7] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, AUSD, USDC, 50, 1, address(0));
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
                    usdc: USDC,
                    v2Factories: new address[](0),
                    v2QuoteSelectors: new bytes4[](0)
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
        idUniUsdcWmon = pools.poolIdOf(ps[0]);
        idCakeUsdcWmon = pools.poolIdOf(ps[1]);
        idCakeCbbtcWmon = pools.poolIdOf(ps[2]);
        idUniShmonWmon = pools.poolIdOf(ps[3]);
        idV4MonUsdc = pools.poolIdOf(ps[4]);
        idV4WbtcMon = pools.poolIdOf(ps[5]);
        idV4WethMon = pools.poolIdOf(ps[6]);
        idV4AusdUsdc = pools.poolIdOf(ps[7]);
        oracle = new OracleAdapterV3(
            ITokenRegistry(address(tokens)),
            IPoolRegistry(address(pools)),
            IUniswapV4StateView(STATE_VIEW),
            USDC,
            WMON,
            200
        );
        address[] memory allow = new address[](4);
        (allow[0], allow[1], allow[2], allow[3]) = (owner, alice, bob, buyer);
        factory = new AccountFactoryV3(
            AccountFactoryV3.Deployment({
                admin: admin,
                guardian: guardian,
                sentinel: makeAddr("fork sentinel"),
                oracle: address(oracle),
                executor: address(executor),
                agentNft: IAgentNFTView(address(nft)),
                usdc: USDC,
                tokenRegistry: ITokenRegistry(address(tokens)),
                personalCap: 1_000e6,
                vaultCap: 5_000e6,
                platformCap: 20_000e6,
                depositsEnabled: false,
                allowlist: allow,
                personalImplementation: address(
                    new PersonalAccountV3(IAgentNFTView(address(nft)), USDC, ITokenRegistry(address(tokens)), 0, 0)
                ),
                vaultImplementation: address(
                    new StrategyVaultV3(IAgentNFTView(address(nft)), USDC, ITokenRegistry(address(tokens)), 0, 0)
                )
            })
        );
        vm.prank(admin);
        executor.bind(IExecutorFactoryV3(address(factory)), IPoolRegistry(address(pools)));

        // The vault: the leader's 100 USDC seed, deposits opened, 100 USDC from Alice and from Bob.
        vm.prank(owner);
        sv = StrategyVaultV3(factory.createVault(AGENT));
        address[3] memory wallets = [owner, alice, bob];
        for (uint256 i = 0; i < wallets.length; ++i) {
            _mintUsdc(wallets[i], 100e6);
            vm.prank(wallets[i]);
            IERC20(USDC).approve(address(sv), type(uint256).max);
        }
        _mintUsdc(buyer, 100e6);
        vm.prank(buyer);
        IERC20(USDC).approve(address(sv), type(uint256).max);
        vm.startPrank(owner);
        sv.deposit(100e6, 0);
        sv.setDepositsOpen(true);
        executor.registerVaultSession(AGENT, session);
        vm.stopPrank();
        vm.prank(alice);
        sv.deposit(100e6, 0);
        vm.prank(bob);
        sv.deposit(100e6, 0);
        assertEq(sv.navUsdc(), 300e6);

        // The session key buys 25 USDC of each other token through the real pools; a pool that
        // sits more than the slippage limit off its feed at this block refuses its buy (F-U4).
        bought.push(USDC);
        _tryBuy(WMON, 25e6, _r(idCakeUsdcWmon));
        _tryBuy(WBTC, 25e6, _r(idCakeUsdcWmon, idV4WbtcMon));
        _tryBuy(CBBTC, 25e6, _r(idCakeUsdcWmon, idCakeCbbtcWmon));
        _tryBuy(WETH, 25e6, _r(idCakeUsdcWmon, idV4WethMon));
        _tryBuy(AUSD, 25e6, _r(idV4AusdUsdc));
        _tryBuy(SHMON, 25e6, _r(idCakeUsdcWmon, idUniShmonWmon));
        if (bought.length < 2) _tryBuy(WMON, 25e6, _r(idUniUsdcWmon));
        assertGe(bought.length, 3, "at least two real tokens bought beside USDC");
        assertEq(sv.heldCount(), bought.length);
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

    function _decimals(address token) internal view returns (uint8) {
        return tokens.tokenRecord(token).decimals;
    }

    function _price(address token) internal view returns (uint256 px) {
        PriceReason r;
        (px,, r) = oracle.price(token);
        assertEq(uint8(r), uint8(PriceReason.OK), "priced");
    }

    function _value(address token, uint256 amount) internal view returns (uint256) {
        return amount * _price(token) / (10 ** uint256(_decimals(token))) / 1e12;
    }

    /// A valid intent for the vault at the floor the Executor computes from the feeds.
    function _intent(address tokenIn, address tokenOut, uint256 amountIn, bytes32[] memory route)
        internal
        returns (SwapIntentV3 memory i)
    {
        uint256 floor = executor.floorFor(
            amountIn, _price(tokenIn), _decimals(tokenIn), _price(tokenOut), _decimals(tokenOut), 50
        );
        i = SwapIntentV3({
            schemaVersion: 2,
            chainId: block.chainid,
            agentId: AGENT,
            account: address(sv),
            actionId: keccak256(abi.encode("vault fork action", ++actionCounter)),
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

    /// A buy for the vault that may be refused by the pool's price at this block; a fill is
    /// checked for the per-trade loss bound and the Executor keeping nothing.
    function _tryBuy(address token, uint256 usdcIn, bytes32[] memory route) internal {
        SwapIntentV3 memory i = _intent(USDC, token, usdcIn, route);
        uint256 navBefore = sv.navUsdc();
        uint256 supply = sv.totalSupply();
        vm.prank(session);
        try executor.swap(i) returns (uint256 out) {
            assertGt(out, 0);
            uint256 navAfter = sv.navUsdc();
            // Per-trade loss bounded by the slippage limit and the route's fees: within 1% of what was sent.
            assertGe(navAfter + usdcIn / 100, navBefore, "a trade lost more than the slippage limit");
            assertEq(sv.totalSupply(), supply, "a trade touched the shares");
            assertEq(IERC20(token).balanceOf(address(executor)), 0, "the Executor keeps nothing");
            assertEq(IERC20(token).balanceOf(address(router)), 0, "the adapter keeps nothing");
            bought.push(token);
            emit log_named_string("bought", vm.toString(token));
        } catch {
            emit log_named_string("buy refused at this block", vm.toString(token));
        }
    }

    function _r(bytes32 a) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](1);
        r[0] = a;
    }

    function _r(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](2);
        (r[0], r[1]) = (a, b);
    }

    /// Replaces every contract but the tokens and the vault with code that
    /// reverts at once (PUSH1 0 PUSH1 0 REVERT): an INVALID opcode would burn
    /// every unit of gas a call forwards, which is not what a dead contract does.
    function _breakEverything() internal {
        bytes memory dead = hex"60006000fd";
        address[14] memory gone = [
            address(oracle),
            address(tokens),
            address(pools),
            address(factory),
            address(executor),
            address(router),
            address(nft),
            FEED_MON_USD,
            FEED_USDC_USD,
            FEED_WBTC_USD,
            FEED_CBBTC_USD,
            FEED_WETH_USD,
            FEED_AUSD_USD,
            FEED_SHMON_RATE
        ];
        for (uint256 k = 0; k < gone.length; ++k) {
            vm.etch(gone[k], dead);
        }
    }

    /// `who` leaves in kind; every held token's payout is the previewed floor; the gas is logged.
    function _exitInKind(address who, string memory label) internal returns (uint256 gas) {
        uint256 shares = sv.sharesOf(who);
        (address[] memory heldTokens, uint256[] memory preview) = sv.inKindAmounts(shares);
        uint256[] memory before = new uint256[](heldTokens.length);
        for (uint256 k = 0; k < heldTokens.length; ++k) {
            before[k] = IERC20(heldTokens[k]).balanceOf(who);
        }
        vm.prank(who);
        gas = gasleft();
        sv.redeemInKind(shares, who);
        gas -= gasleft();
        emit log_named_uint(label, gas);
        for (uint256 k = 0; k < heldTokens.length; ++k) {
            assertEq(IERC20(heldTokens[k]).balanceOf(who) - before[k], preview[k], "the floor of the slice");
        }
        assertEq(sv.sharesOf(who), 0);
    }

    // ----- tests -----

    /// Lockups hold on real tokens; then the USDC exit for one depositor and, with
    /// every other contract reverting, the in-kind exits for the rest (M-13, M-31).
    function test_EveryoneLeavesRealTokensInKindWithEverythingElseReverting() public {
        emit log_named_uint("tokens held", sv.heldCount());
        // The lockup holds: a day has not passed.
        uint256 aliceShares = sv.sharesOf(alice);
        (, uint64 unlockAt) = sv.lockOf(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.SharesLocked.selector, 0, unlockAt));
        sv.redeem(aliceShares, alice, 0, uint64(block.timestamp + 60));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.SharesLocked.selector, 0, unlockAt));
        sv.redeemInKind(aliceShares, alice);
        // The guardian pauses: locks are waived, exits stay open, nothing trades.
        vm.prank(guardian);
        sv.pause();
        assertEq(sv.freeShares(alice), aliceShares);
        SwapIntentV3 memory buy = _intent(USDC, WMON, 10e6, _r(idCakeUsdcWmon));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.PAUSED));
        executor.swap(buy);
        // Alice: the USDC path at the real feeds' value less the spread, from USDC above the floor.
        uint256 nav = sv.navUsdc();
        uint256 expected = sv.convertToAssets(aliceShares);
        vm.prank(alice);
        uint256 gas = gasleft();
        uint256 paid = sv.redeem(aliceShares, alice, 0, uint64(block.timestamp + 60));
        gas -= gasleft();
        emit log_named_uint("gas: redeem (USDC path), real tokens held", gas);
        assertEq(paid, expected);
        assertEq(IERC20(USDC).balanceOf(alice), paid);
        assertLt(paid, 100e6, "no round trip creates value");
        assertGt(paid, 95e6, "the real fills cost under 5%");
        assertEq(sv.navUsdc(), nav - paid);
        // Everything else dies; Bob and the leader still leave with every held token.
        _breakEverything();
        vm.expectRevert();
        sv.navUsdc();
        vm.prank(bob);
        vm.expectRevert();
        sv.redeem(1, bob, 0, uint64(block.timestamp + 60));
        uint256 gasBob = _exitInKind(bob, "gas: redeemInKind, real tokens held (a depositor)");
        assertLt(gasBob, 3_000_000);
        _exitInKind(owner, "gas: redeemInKind, real tokens held (the leader, last)");
        assertEq(sv.totalSupply(), 0);
        for (uint256 k = 0; k < bought.length; ++k) {
            assertEq(IERC20(bought[k]).balanceOf(address(sv)), 0, "the vault is empty");
            assertGt(IERC20(bought[k]).balanceOf(bob), 0, "bob holds his slice");
        }
        assertEq(sv.heldCount(), 1);
    }

    /// The leader cannot take depositors' funds: not below the stake while others
    /// remain, never directly, never through the Executor outside the limits.
    function test_TheLeaderCannotExtractDepositorsFunds() public {
        // Through the Executor: a trade above 10% of value, and buys past 40% in one token, are refused.
        SwapIntentV3 memory big = _intent(USDC, WMON, 31e6, _r(idCakeUsdcWmon));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.TRADE_SIZE_EXCEEDED));
        executor.swap(big);
        bool capped;
        for (uint256 k = 0; k < 8 && !capped; ++k) {
            SwapIntentV3 memory more = _intent(USDC, WMON, 28e6, _r(idCakeUsdcWmon));
            vm.prank(session);
            try executor.swap(more) returns (uint256) {
                (uint256 cap,,) = sv.capValues();
                assertLe(_value(WMON, sv.freeBalance(WMON)) * 10_000, cap * 4_000 + 1, "WMON stayed inside 40%");
            } catch (bytes memory ret) {
                assertEq(bytes4(ret), ExecutorV3.Rejected.selector);
                capped = true;
            }
        }
        assertTrue(capped, "the concentration cap bound the buys");
        // Directly: nobody takes the vault's tokens, the leader included; only the Executor trades.
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, owner));
        sv.withdraw(USDC, 1, owner);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, owner));
        sv.withdrawAll(owner);
        vm.stopPrank();
        SwapParamsV3 memory direct = SwapParamsV3({
            tokenIn: USDC,
            tokenOut: WMON,
            amountIn: 1e6,
            minAmountOut: 1,
            routeHash: bytes32(0),
            deadline: uint64(block.timestamp + 60),
            ownershipEpoch: nft.ownerEpoch(AGENT),
            configEpoch: 0,
            attestationIn: "",
            attestationOut: ""
        });
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotExecutor.selector, owner));
        sv.executeSwap(direct);
        // The leader's exit keeps 5% while others remain (the pause waives the lock, not the stake rule).
        vm.prank(guardian);
        sv.pause();
        uint256 stake = sv.leaderShares();
        vm.prank(owner);
        vm.expectPartialRevert(StrategyVaultV3.LeaderStakeTooLow.selector);
        sv.redeemInKind(stake, owner);
        vm.prank(owner);
        vm.expectPartialRevert(StrategyVaultV3.LeaderStakeTooLow.selector);
        sv.redeemInKind(stake * 9 / 10, owner);
        // A tenth of the stake leaves; the rest stays as the floor under the depositors.
        vm.prank(owner);
        sv.redeemInKind(stake / 10, owner);
        assertGe(sv.leaderStakeBps(), 500);
    }

    /// A sale of the agent: nothing trades, nobody deposits, everyone may leave,
    /// and the buyer takes over only after the handover period with a stake.
    function test_HandoverHoldsOnRealTokens() public {
        nft.setOwner(AGENT, buyer);
        assertTrue(sv.inHandover());
        assertEq(sv.manager(), address(0));
        assertEq(uint8(sv.effectiveMode()), uint8(AccountMode.HANDOVER));
        vm.prank(buyer);
        executor.registerVaultSession(AGENT, session);
        SwapIntentV3 memory buy = _intent(USDC, WMON, 10e6, _r(idCakeUsdcWmon));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.VAULT_IN_HANDOVER));
        executor.swap(buy);
        vm.prank(alice);
        vm.expectRevert(StrategyVaultV3.InHandover.selector);
        sv.deposit(1e6, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.NotManager.selector, owner));
        sv.setDepositsOpen(false);
        // Locks are waived: Alice leaves in kind at once with every real token's slice.
        assertEq(sv.freeShares(alice), sv.sharesOf(alice));
        _exitInKind(alice, "gas: redeemInKind in handover, real tokens held");
        // The buyer stakes now (the deposit path needs the feeds fresh), waits the period, accepts.
        vm.prank(buyer);
        uint256 stake = sv.stakeAsIncomingLeader(50e6, 0);
        assertEq(sv.incomingShares(), stake);
        vm.prank(buyer);
        vm.expectPartialRevert(StrategyVaultV3.HandoverTooRecent.selector);
        sv.acceptManagement();
        vm.warp(block.timestamp + 3 days);
        uint256 oldStake = sv.leaderShares();
        vm.prank(buyer);
        sv.acceptManagement();
        assertFalse(sv.inHandover());
        assertEq(sv.leader(), buyer);
        assertEq(sv.manager(), buyer);
        assertEq(sv.leaderShares(), stake);
        assertEq(sv.balanceOf(owner), oldStake, "the old leader's stake is ordinary now");
        assertEq(sv.freeShares(owner), oldStake, "and unlocked");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.NotAgentOwner.selector, owner));
        executor.registerVaultSession(AGENT, session);
    }

    /// Flows move no value between depositors on real tokens: a deposit and an
    /// in-kind exit by one holder never lower the price per share for the others.
    function test_FlowsMoveNoValueBetweenDepositorsOnRealTokens() public {
        sv.poke();
        uint256 before = sv.sharePriceE18();
        uint256 aliceClaim = sv.convertToAssets(sv.sharesOf(alice));
        _mintUsdc(bob, 50e6);
        vm.prank(bob);
        sv.deposit(50e6, 0);
        assertGe(sv.sharePriceE18(), before, "a deposit never lowers the price per share");
        assertGe(sv.convertToAssets(sv.sharesOf(alice)), aliceClaim, "Alice's claim did not fall");
        vm.prank(guardian);
        sv.pause();
        uint256 mid = sv.sharePriceE18();
        uint256 bobShares = sv.sharesOf(bob);
        vm.prank(bob);
        sv.redeemInKind(bobShares / 2, bob);
        sv.poke();
        assertGe(sv.sharePriceE18(), mid, "an in-kind exit never lowers the price per share");
        assertGe(sv.convertToAssets(sv.sharesOf(alice)), aliceClaim);
    }
}
