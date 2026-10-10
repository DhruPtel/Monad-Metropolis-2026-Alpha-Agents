// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {AccountFactoryV3} from "../../src/fund/AccountFactoryV3.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {RouteAdapter} from "../../src/fund/RouteAdapter.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {FeedConfig, FeedLeg, IPoolRegistry, ITokenRegistry, PriceClass, Venue} from "../../src/interfaces/IFund.sol";
import {IUniswapV4StateView} from "../../src/interfaces/IOracle.sol";
import {IPoolManager} from "../../src/interfaces/IUniswap.sol";
import {IUniswapV3PoolView} from "../../src/interfaces/IUniswapV3.sol";
import {MockAgentNFT} from "../mocks/CustodyMocks.sol";
import {IFiatToken} from "./CustodyFork.t.sol";

/// PersonalAccountV3 against Monad's real tokens and feeds at the pinned block
/// (F-U3): seven core tokens, six of them bought through the real pools with
/// the RouteAdapter, deposited at their own feed prices and withdrawn without
/// any price; Circle's real blacklist and pause turning USDC into a credit
/// while the other six still come out; and the real feeds pricing the whole
/// portfolio. Runs only on a fork named by LOCAL_FORK_URL (L-100).
contract CustodyV3ForkTest is Test {
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
    AccountFactoryV3 internal factory;
    PersonalAccountV3 internal account;
    MockAgentNFT internal nft;
    address internal owner = makeAddr("fork owner");
    address internal admin = makeAddr("fork admin");

    address[7] internal all = [USDC, WMON, WBTC, CBBTC, WETH, AUSD, SHMON];
    /// What the owner deposits of each: 50 USDC, and what 10 USDC bought of every other token.
    uint256[7] internal amounts;
    bytes32 internal idUniUsdcWmon;
    bytes32 internal idCakeUsdcWmon;
    bytes32 internal idCakeCbbtcWmon;
    bytes32 internal idUniShmonWmon;
    bytes32 internal idV4WbtcMon;
    bytes32 internal idV4WethMon;
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
        seeds[0] = _seed(USDC, 10_000, FeedLeg(0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec, 8, 3_900), none);
        seeds[1] = _seed(WMON, 4_500, monUsd, none);
        seeds[2] = _seed(WBTC, 4_500, FeedLeg(0x2D1Df1bD061AAc38C22407AD69d69bCC3C62edBD, 8, 3_900), none);
        seeds[3] = _seed(CBBTC, 4_500, FeedLeg(0x3dDc1bAE752aaEe31b577bF844c799C349A1d6BD, 8, 3_900), none);
        seeds[4] = _seed(WETH, 4_500, FeedLeg(0x1B1414782B859871781bA3E4B0979b9ca57A0A04, 8, 3_900), none);
        seeds[5] = _seed(AUSD, 4_500, FeedLeg(0xE20751C7B5867bCBef815ffc1b284c3f412a9e13, 8, 3_900), none);
        seeds[6] = _seed(SHMON, 4_500, monUsd, FeedLeg(0x2dC0b316e3d4e673C7F9A809e80a3e60b26d7774, 18, 90_000));
        tokens = new TokenRegistry(admin, admin, admin, seeds);

        ProtocolRegistryV3.PoolSeed[] memory ps = new ProtocolRegistryV3.PoolSeed[](7);
        ps[0] = _v3(Venue.UNISWAP_V3, UNI_USDC_WMON_3000);
        ps[1] = _v3(Venue.PANCAKESWAP_V3, CAKE_USDC_WMON_500);
        ps[2] = _v3(Venue.PANCAKESWAP_V3, CAKE_CBBTC_WMON_500);
        ps[3] = _v3(Venue.UNISWAP_V3, UNI_SHMON_WMON_100);
        ps[4] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, address(0), WBTC, 500, 1, address(0));
        ps[5] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, address(0), WETH, 500, 1, address(0));
        ps[6] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, AUSD, USDC, 50, 1, address(0));
        pools = new ProtocolRegistryV3(
            admin,
            admin,
            admin,
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
        idV4WbtcMon = pools.poolIdOf(ps[4]);
        idV4WethMon = pools.poolIdOf(ps[5]);
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

        nft = new MockAgentNFT();
        nft.setOwner(1, owner);
        address[] memory allow = new address[](1);
        allow[0] = owner;
        factory = new AccountFactoryV3(
            AccountFactoryV3.Deployment({
                admin: admin,
                guardian: makeAddr("guardian"),
                sentinel: makeAddr("sentinel"),
                oracle: address(oracle),
                executor: address(0),
                agentNft: IAgentNFTView(address(nft)),
                usdc: USDC,
                tokenRegistry: ITokenRegistry(address(tokens)),
                personalCap: 1_000e6,
                platformCap: 20_000e6,
                allowlist: allow
            })
        );
        vm.prank(owner);
        account = PersonalAccountV3(factory.createPersonalAccount(1));
    }

    function _seed(address token, uint16 cap, FeedLeg memory usd, FeedLeg memory rate)
        internal
        pure
        returns (TokenRegistry.CoreSeed memory)
    {
        return TokenRegistry.CoreSeed(token, PriceClass.F, cap, FeedConfig(usd, rate));
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

    /// Real USDC from Circle's minter; every other token bought for `to` with
    /// 10 USDC through its real pools, this test being the adapter's Executor.
    function _fund(address token, address to) internal returns (uint256 got) {
        if (token == USDC) {
            _mintUsdc(to, 50e6);
            return 50e6;
        }
        _mintUsdc(address(this), 10e6);
        IERC20(USDC).transfer(address(adapter), 10e6);
        bytes32[] memory r;
        if (token == WMON) {
            r = new bytes32[](1);
            r[0] = idUniUsdcWmon;
        } else if (token == AUSD) {
            r = new bytes32[](1);
            r[0] = idV4AusdUsdc;
        } else {
            r = new bytes32[](2);
            r[0] = token == CBBTC ? idCakeUsdcWmon : idUniUsdcWmon;
            r[1] = token == WBTC
                ? idV4WbtcMon
                : token == CBBTC ? idCakeCbbtcWmon : token == WETH ? idV4WethMon : idUniShmonWmon;
        }
        got = adapter.swapRoute(USDC, token, 10e6, 1, to, r, false);
        assertGt(got, 0, "bought");
    }

    /// The USDC value of an amount of a core token at its own feed.
    function _value(address token, uint256 amount) internal view returns (uint256) {
        uint256 px = oracle.priceE18(token);
        return amount * px / (10 ** uint256(tokens.tokenRecord(token).decimals)) / 1e12;
    }

    function _depositAll() internal returns (uint256 expectedNav) {
        for (uint256 i = 0; i < all.length; ++i) {
            amounts[i] = _fund(all[i], owner);
            vm.startPrank(owner);
            IERC20(all[i]).approve(address(account), amounts[i]);
            account.deposit(all[i], amounts[i]);
            vm.stopPrank();
            expectedNav += _value(all[i], amounts[i]);
        }
    }

    function test_SevenRealTokensDepositAtTheirOwnFeedPrices_AndWithdrawWithNoPrice() public {
        uint256 expectedNav = _depositAll();
        assertEq(account.heldCount(), 7);
        assertEq(account.navUsdc(), expectedNav);
        assertEq(account.principal(), expectedNav);
        assertLt(expectedNav, 1_000e6, "inside the cap");
        // Every token's cost basis is what it was worth when deposited.
        for (uint256 i = 1; i < all.length; ++i) {
            assertEq(account.costBasis(all[i]), _value(all[i], amounts[i]));
        }
        (uint256 nav, uint256 perUnit,,) = account.breakerState();
        assertEq(nav, expectedNav);
        assertEq(perUnit, 1e18);

        // Withdraw with every price gone: the oracle and the registry replaced by reverting code.
        vm.etch(address(oracle), hex"fe");
        vm.etch(address(tokens), hex"fe");
        vm.prank(owner);
        account.withdraw(WBTC, amounts[2] / 2, owner);
        vm.prank(owner);
        account.withdrawAll(owner);
        for (uint256 i = 0; i < all.length; ++i) {
            assertEq(IERC20(all[i]).balanceOf(owner), amounts[i], "every token came back");
            assertEq(IERC20(all[i]).balanceOf(address(account)), 0);
        }
        assertEq(account.heldCount(), 1);
        assertEq(account.units(), 0);
        assertEq(account.principal(), 0);
        assertEq(factory.platformTotal(), 0);
    }

    /// Circle blacklists the account: USDC is credited while the six others come
    /// out, and the credit pays out once the blacklist is lifted.
    function test_ABlacklistedAccountsUsdcIsCreditedAndSixTokensStillWithdraw() public {
        _depositAll();
        IFiatToken usdc = IFiatToken(USDC);
        vm.prank(usdc.blacklister());
        usdc.blacklist(address(account));
        vm.prank(owner);
        account.withdrawAll(owner);
        for (uint256 i = 1; i < all.length; ++i) {
            assertEq(IERC20(all[i]).balanceOf(owner), amounts[i]);
        }
        assertEq(account.claimable(USDC, owner), amounts[0]);
        assertEq(account.freeBalance(USDC), 0);
        assertEq(account.navUsdc(), 0, "credits are not value");
        vm.prank(owner);
        vm.expectRevert();
        account.claim(USDC, owner);
        vm.prank(usdc.blacklister());
        usdc.unBlacklist(address(account));
        vm.prank(owner);
        account.claim(USDC, owner);
        assertEq(IERC20(USDC).balanceOf(owner), amounts[0]);
        assertEq(account.claimable(USDC, owner), 0);
    }

    /// Circle pauses USDC: the same, and a blacklisted owner claims to another address.
    function test_APausedUsdcIsCredited_AndABlacklistedOwnerClaimsElsewhere() public {
        _depositAll();
        IFiatToken usdc = IFiatToken(USDC);
        vm.prank(usdc.pauser());
        usdc.pause();
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(IERC20(SHMON).balanceOf(owner), amounts[6]);
        assertEq(account.claimable(USDC, owner), amounts[0]);
        vm.prank(usdc.pauser());
        usdc.unpause();
        vm.prank(usdc.blacklister());
        usdc.blacklist(owner);
        address safe = makeAddr("safe");
        vm.prank(owner);
        vm.expectRevert();
        account.claim(USDC, owner);
        vm.prank(owner);
        account.claim(USDC, safe);
        assertEq(IERC20(USDC).balanceOf(safe), amounts[0]);
    }

    /// The real feeds price the whole portfolio, and a poke records it.
    function test_TheRealFeedsPriceThePortfolioAndThePokeRecordsIt() public {
        uint256 expectedNav = _depositAll();
        (uint256 nav, uint256 perUnit, uint256 peak) = account.poke();
        assertEq(nav, expectedNav);
        assertEq(perUnit, 1e18);
        assertEq(peak, 1e18);
        (uint256 capped, uint256 totalBasis, uint256 classABasis) = account.capValues();
        assertEq(capped, expectedNav);
        assertEq(totalBasis, expectedNav);
        assertEq(classABasis, 0);
        CustodyCoreV3.Holding[] memory h = account.holdings();
        assertEq(h.length, 7);
        assertEq(h[6].token, SHMON);
        assertEq(h[6].lastPriceE18, oracle.priceE18(SHMON));
    }

    /// Native MON cannot be sent in: accounts hold WMON only (D-167).
    function test_RejectsNativeMon() public {
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        (bool ok,) = address(account).call{value: 1 ether}("");
        assertFalse(ok);
    }
}
