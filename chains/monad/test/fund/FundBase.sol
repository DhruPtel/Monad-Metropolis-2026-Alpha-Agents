// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {FeedConfig, FeedLeg, ITokenRegistry, IPoolRegistry, PriceClass, Venue} from "../../src/interfaces/IFund.sol";
import {IPoolManager, PoolKey} from "../../src/interfaces/IUniswap.sol";
import {IUniswapV4StateView} from "../../src/interfaces/IOracle.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {RouteAdapter} from "../../src/fund/RouteAdapter.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {MockToken} from "../mocks/CustodyMocks.sol";
import {MockFeed} from "../mocks/OracleMocks.sol";
import {
    MockFundAccount,
    MockPoolManager,
    MockStateViewAny,
    MockV3Factory,
    MockV3Pool,
    MockWMON
} from "../mocks/FundMocks.sol";

/// A whole v3 set on mocks (F-U2): USDC, WMON and two more core tokens priced
/// by feeds (one direct, one composite), a class A core token, Uniswap v3 and
/// PancakeSwap v3 pools, two v4 pools (one with native MON), and the adapter
/// with this test as its Executor.
abstract contract FundBase is Test {
    address internal constant ADMIN = address(0xA11CE);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant SCREENER = address(0x5C2E);
    address internal constant OWNER_ACCOUNT_EOA = address(0xB0B);
    uint256 internal constant T0 = 1_790_876_425;

    MockToken internal usdc;
    MockWMON internal wmon;
    MockToken internal tokA; // 18 decimals, class F by its USD feed
    MockToken internal tokB; // 8 decimals, class F composite: B/WMON rate times MON/USD
    MockToken internal tokC; // 18 decimals, class A core

    MockFeed internal monUsd; // 8 decimals, 300 s
    MockFeed internal usdcUsd; // 8 decimals, 3,900 s
    MockFeed internal aUsd; // 8 decimals, 3,900 s
    MockFeed internal bRate; // 18 decimals, 90,000 s

    TokenRegistry internal tokens;
    ProtocolRegistryV3 internal pools;
    OracleAdapterV3 internal oracle;
    RouteAdapter internal adapter;

    MockV3Factory internal uniFactory;
    MockV3Factory internal cakeFactory;
    MockPoolManager internal manager;
    MockStateViewAny internal stateView;

    MockV3Pool internal poolUsdcWmon; // Uniswap v3, 1 WMON = 2 USDC
    MockV3Pool internal poolAWmon; // PancakeSwap v3, 1 A = 3 WMON
    bytes32 internal idUsdcWmon;
    bytes32 internal idAWmon;
    bytes32 internal idMonC; // v4 native MON / C, 1 MON = 5 C
    bytes32 internal idBUsdc; // v4 B / USDC, 1 B (1e8) = 40 USDC

    MockFundAccount internal optedIn;
    MockFundAccount internal notOptedIn;
    MockFundAccount internal vault;

    function setUp() public virtual {
        vm.warp(T0);
        usdc = _newUsdc();
        wmon = new MockWMON();
        tokA = new MockToken("TOKA", 18);
        tokB = new MockToken("TOKB", 8);
        tokC = new MockToken("TOKC", 18);
        monUsd = new MockFeed(8);
        aUsd = new MockFeed(8);
        bRate = new MockFeed(18);
        monUsd.push(2e8); // 2 USD
        aUsd.push(6e8); // 6 USD
        bRate.push(20e18); // 1 B = 20 MON

        TokenRegistry.CoreSeed[] memory seeds = new TokenRegistry.CoreSeed[](4);
        seeds[0] = _seed(address(wmon), PriceClass.F, _feed(monUsd, 8, 300), _noLeg());
        seeds[1] = _seed(address(tokA), PriceClass.F, _feed(aUsd, 8, 3_900), _noLeg());
        seeds[2] = _seed(address(tokB), PriceClass.F, _feed(monUsd, 8, 300), _feed(bRate, 18, 90_000));
        seeds[3] = _seed(address(tokC), PriceClass.A, _noLeg(), _noLeg());
        tokens = new TokenRegistry(ADMIN, GUARDIAN, SCREENER, _withUsdc(seeds));

        uniFactory = new MockV3Factory();
        cakeFactory = new MockV3Factory();
        manager = new MockPoolManager();
        stateView = new MockStateViewAny();

        (address u0, address u1) = _sorted(address(usdc), address(wmon));
        poolUsdcWmon = new MockV3Pool(u0, u1, 3_000, 60);
        // 1 WMON (1e18) = 2 USDC (2e6).
        if (u0 == address(wmon)) poolUsdcWmon.setPrice(2e6, 1e18, 0);
        else poolUsdcWmon.setPrice(1e18, 2e6, 0);
        uniFactory.setPool(u0, u1, 3_000, address(poolUsdcWmon));

        (address a0, address a1) = _sorted(address(tokA), address(wmon));
        poolAWmon = new MockV3Pool(a0, a1, 2_500, 50);
        if (a0 == address(tokA)) poolAWmon.setPrice(3, 1, 0);
        else poolAWmon.setPrice(1, 3, 0);
        poolAWmon.setMode(MockV3Pool.Mode.Pancake);
        cakeFactory.setPool(a0, a1, 2_500, address(poolAWmon));

        PoolKey memory monC = PoolKey(address(0), address(tokC), 500, 10, address(0));
        manager.setPrice(monC, 5, 1);
        (address b0, address b1) = _sorted(address(tokB), address(usdc));
        PoolKey memory bUsdc = PoolKey(b0, b1, 500, 10, address(0));
        // 1 B (1e8) = 40 USDC (40e6): raw ratio 40e6 / 1e8.
        if (b0 == address(tokB)) manager.setPrice(bUsdc, 40e6, 1e8);
        else manager.setPrice(bUsdc, 1e8, 40e6);
        idMonC = keccak256(abi.encode(monC));
        idBUsdc = keccak256(abi.encode(bUsdc));
        stateView.setSqrt(idMonC, uint160(2 ** 96));
        stateView.setSqrt(idBUsdc, uint160(2 ** 96));

        ProtocolRegistryV3.PoolSeed[] memory ps = new ProtocolRegistryV3.PoolSeed[](4);
        ps[0] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V3, u0, u1, 3_000, 60, address(poolUsdcWmon));
        ps[1] = ProtocolRegistryV3.PoolSeed(Venue.PANCAKESWAP_V3, a0, a1, 2_500, 50, address(poolAWmon));
        ps[2] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, address(0), address(tokC), 500, 10, address(0));
        ps[3] = ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, b0, b1, 500, 10, address(0));
        pools = new ProtocolRegistryV3(
            ADMIN,
            GUARDIAN,
            SCREENER,
            ITokenRegistry(address(tokens)),
            ProtocolRegistryV3.Venues({
                uniswapV3Factory: address(uniFactory),
                pancakeswapV3Factory: address(cakeFactory),
                poolManager: address(manager),
                stateView: IUniswapV4StateView(address(stateView)),
                wmon: address(wmon),
                usdc: address(usdc)
            }),
            ps,
            new bytes32[](0),
            new address[](0)
        );
        idUsdcWmon = bytes32(uint256(uint160(address(poolUsdcWmon))));
        idAWmon = bytes32(uint256(uint160(address(poolAWmon))));

        oracle = new OracleAdapterV3(
            ITokenRegistry(address(tokens)),
            IPoolRegistry(address(pools)),
            IUniswapV4StateView(address(stateView)),
            address(usdc),
            address(wmon),
            200
        );
        adapter = new RouteAdapter(
            IPoolRegistry(address(pools)), IPoolManager(address(manager)), address(wmon), address(usdc), address(this)
        );

        // Liquidity for every pool, and native MON for the pool manager.
        usdc.mint(address(poolUsdcWmon), 1e15);
        _wmonTo(address(poolUsdcWmon), 1e27);
        tokA.mint(address(poolAWmon), 1e27);
        _wmonTo(address(poolAWmon), 1e27);
        tokC.mint(address(manager), 1e27);
        tokB.mint(address(manager), 1e20);
        usdc.mint(address(manager), 1e15);
        vm.deal(address(manager), 1e27);

        optedIn = new MockFundAccount();
        optedIn.set(true, false);
        notOptedIn = new MockFundAccount();
        vault = new MockFundAccount();
        vault.set(true, true);
    }

    /// USDC as a plain mock; a subclass may make it a hostile token (the reentrancy tests).
    function _newUsdc() internal virtual returns (MockToken) {
        return new MockToken("USDC", 6);
    }

    /// Fresh rounds on every feed at the same answers, after a warp.
    function _refreshFeeds() internal {
        monUsd.push(2e8);
        usdcUsd.push(1e8);
        aUsd.push(6e8);
        bRate.push(20e18);
    }

    function _wmonTo(address to, uint256 amount) internal {
        vm.deal(address(this), amount);
        wmon.deposit{value: amount}();
        wmon.transfer(to, amount);
    }

    function _sorted(address a, address b) internal pure returns (address, address) {
        return a < b ? (a, b) : (b, a);
    }

    function _feed(MockFeed f, uint8 decimals, uint32 maxAge) internal pure returns (FeedLeg memory) {
        return FeedLeg(address(f), decimals, maxAge);
    }

    function _noLeg() internal pure returns (FeedLeg memory l) {}

    function _seed(address token, PriceClass cls, FeedLeg memory usdLeg, FeedLeg memory rateLeg)
        internal
        pure
        returns (TokenRegistry.CoreSeed memory)
    {
        return TokenRegistry.CoreSeed(token, cls, 4_500, FeedConfig(usdLeg, rateLeg));
    }

    /// USDC is a core token too: class F by definition, valued at exactly 1 by the oracle.
    function _withUsdc(TokenRegistry.CoreSeed[] memory seeds) internal returns (TokenRegistry.CoreSeed[] memory out) {
        usdcUsd = new MockFeed(8);
        usdcUsd.push(1e8);
        out = new TokenRegistry.CoreSeed[](seeds.length + 1);
        out[0] = _seed(address(usdc), PriceClass.F, _feed(usdcUsd, 8, 3_900), _noLeg());
        for (uint256 i = 0; i < seeds.length; ++i) {
            out[i + 1] = seeds[i];
        }
    }

    function _route(bytes32 a) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](1);
        r[0] = a;
    }

    function _route(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](2);
        r[0] = a;
        r[1] = b;
    }

    function _route(bytes32 a, bytes32 b, bytes32 c) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    receive() external payable {}
}
