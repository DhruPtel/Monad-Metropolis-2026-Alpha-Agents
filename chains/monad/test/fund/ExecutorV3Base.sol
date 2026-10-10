// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AccountFactoryV3} from "../../src/fund/AccountFactoryV3.sol";
import {ExecutorV3} from "../../src/fund/ExecutorV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {RouteAdapter} from "../../src/fund/RouteAdapter.sol";
import {AccountMode, IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {IExecutorFactoryV3, PolicyV3, ReasonV3, SwapIntentV3} from "../../src/interfaces/IExecutorV3.sol";
import {IPoolRegistry, ITokenRegistry, PriceClass, Venue} from "../../src/interfaces/IFund.sol";
import {IPoolManager, PoolKey} from "../../src/interfaces/IUniswap.sol";
import {MockAgentNFT, MockToken} from "../mocks/CustodyMocks.sol";
import {MockAttestor} from "../mocks/CustodyV3Mocks.sol";
import {MockRouteAdapter} from "../mocks/ExecutorV3Mocks.sol";
import {MockV3Pool} from "../mocks/FundMocks.sol";
import {FundBase} from "./FundBase.sol";

/// The whole fund trading stack over mocks (F-U4): FundBase's registries,
/// oracle and pools (every pool priced on its feed), the real ExecutorV3, an
/// AccountFactoryV3 deployed with it, one PersonalAccountV3, the real
/// RouteAdapter bound to the Executor and a misbehaving mock venue, both
/// registered through the ProtocolRegistryV3's timelock, a mock attestor not
/// yet set as the verifier (as on the chain until F-U12), and three screened
/// class A tokens D, E and F, each with its own screened pool against USDC.
/// Prices (USDC per whole token): USDC 1, WMON 2, A 6, B 40 (composite), C 0.40
/// (class A, core), D 2 (6 decimals), E 0.50 and F 10 (class A, screened). The
/// account starts at 700 USDC and 150 WMON: NAV 1,000 USDC, 30% WMON. Caps are
/// wide, so limits bind, not caps.
abstract contract ExecutorV3Base is FundBase {
    bytes32 internal constant ROUTER = keccak256("route-adapter");
    bytes32 internal constant VENUE = keccak256("mock venue");
    uint256 internal constant AGENT = 7;
    uint256 internal constant PERSONAL_CAP = 1_000_000e6;
    uint256 internal constant PLATFORM_CAP = 10_000_000e6;
    uint64 internal constant ATTESTATION_LIFE = 60;
    uint256 internal constant PX_USDC = 1e18;
    uint256 internal constant PX_WMON = 2e18;
    uint256 internal constant PX_A = 6e18;
    uint256 internal constant PX_B = 40e18;
    uint256 internal constant PX_C = 0.4e18;
    uint256 internal constant PX_D = 2e18;
    uint256 internal constant PX_E = 0.5e18;
    uint256 internal constant PX_F = 10e18;

    MockAgentNFT internal nft;
    ExecutorV3 internal executor;
    AccountFactoryV3 internal factory;
    PersonalAccountV3 internal account;
    RouteAdapter internal router;
    MockRouteAdapter internal venue;
    MockAttestor internal attestor;
    MockToken internal tokD;
    MockToken internal tokE;
    MockToken internal tokF;
    bytes32 internal idUsdcD;
    bytes32 internal idUsdcE;
    bytes32 internal idUsdcF;
    PoolKey internal keyUsdcD;

    /// The class A tokens' reference prices, which the attestor and the venue quote.
    mapping(address => uint256) internal refPrice;

    address internal admin = ADMIN;
    address internal guardian = GUARDIAN;
    address internal sentinel = makeAddr("sentinel");
    address internal owner;
    address internal session = makeAddr("session key");
    address internal stranger = makeAddr("stranger");
    uint256 internal actionCounter;
    /// Whether setUp deposits the default 700 USDC and 150 WMON.
    bool internal fundOnBuild = true;

    function launchPolicy() internal pure returns (PolicyV3 memory) {
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

    function setUp() public virtual override {
        super.setUp();
        owner = _makeOwner();
        nft = new MockAgentNFT();
        nft.setOwner(AGENT, owner);
        executor = newExecutor(launchPolicy());

        address[] memory allow = new address[](1);
        allow[0] = owner;
        factory = new AccountFactoryV3(
            AccountFactoryV3.Deployment({
                admin: admin,
                guardian: guardian,
                sentinel: sentinel,
                oracle: address(oracle),
                executor: address(executor),
                agentNft: IAgentNFTView(address(nft)),
                usdc: address(usdc),
                tokenRegistry: ITokenRegistry(address(tokens)),
                personalCap: PERSONAL_CAP,
                platformCap: PLATFORM_CAP,
                allowlist: allow
            })
        );
        vm.prank(admin);
        executor.bind(IExecutorFactoryV3(address(factory)), IPoolRegistry(address(pools)));

        router = new RouteAdapter(
            IPoolRegistry(address(pools)),
            IPoolManager(address(manager)),
            address(wmon),
            address(usdc),
            address(executor)
        );
        venue = new MockRouteAdapter(address(executor));
        registerAdapters();
        pricePools();
        attestor = new MockAttestor();

        // D, E and F: class A in the screened lane, each with its own screened
        // v4 pool against USDC at its price (1 USDC buys 0.5 D, 2 E or 0.1 F).
        tokD = new MockToken("TOKD", 6);
        tokE = new MockToken("TOKE", 18);
        tokF = new MockToken("TOKF", 18);
        (idUsdcD, keyUsdcD) = screenedPool(tokD, "d", 1e6, 2e6);
        (idUsdcE,) = screenedPool(tokE, "e", 2e18, 1e6);
        (idUsdcF,) = screenedPool(tokF, "f", 1e17, 1e6);

        refPrice[address(tokC)] = PX_C;
        refPrice[address(tokD)] = PX_D;
        refPrice[address(tokE)] = PX_E;
        refPrice[address(tokF)] = PX_F;
        venue.setPrice(address(usdc), PX_USDC);
        venue.setPrice(address(wmon), PX_WMON);
        venue.setPrice(address(tokA), PX_A);
        venue.setPrice(address(tokB), PX_B);
        venue.setPrice(address(tokC), PX_C);
        venue.setPrice(address(tokD), PX_D);
        venue.setPrice(address(tokE), PX_E);
        venue.setPrice(address(tokF), PX_F);
        usdc.mint(address(venue), 1e15);
        tokA.mint(address(venue), 1e27);
        tokB.mint(address(venue), 1e20);
        tokC.mint(address(venue), 1e27);
        tokD.mint(address(venue), 1e20);
        tokE.mint(address(venue), 1e27);
        tokF.mint(address(venue), 1e27);
        _wmonTo(address(venue), 1e27);

        vm.prank(owner);
        account = PersonalAccountV3(factory.createPersonalAccount(AGENT));
        if (fundOnBuild) fund(700e6, 150e18);
        grant(uint64(block.timestamp + 7 days));
    }

    /// The owner: a wallet, or a contract in the reentrancy tests.
    function _makeOwner() internal virtual returns (address) {
        return makeAddr("owner");
    }

    /// The Executor setUp deploys; a test may deploy a harness instead.
    function newExecutor(PolicyV3 memory p) internal virtual returns (ExecutorV3) {
        return new ExecutorV3(
            admin,
            guardian,
            IAgentNFTView(address(nft)),
            ITokenRegistry(address(tokens)),
            address(usdc),
            address(wmon),
            p
        );
    }

    // ----- the set -----

    /// A screened class A token with a screened v4 pool against USDC paying
    /// `tokenRaw` of it per `usdcRaw` of USDC, priced for the oracle the same way.
    function screenedPool(MockToken token, string memory screen, uint256 tokenRaw, uint256 usdcRaw)
        internal
        returns (bytes32 id, PoolKey memory key)
    {
        vm.prank(SCREENER);
        tokens.addScreened(address(token), 1_500, keccak256(bytes(screen)), uint64(block.timestamp));
        (address t0, address t1) = _sorted(address(usdc), address(token));
        key = PoolKey(t0, t1, 500, 10, address(0));
        id = keccak256(abi.encode(key));
        (uint256 num, uint256 den) = t0 == address(usdc) ? (tokenRaw, usdcRaw) : (usdcRaw, tokenRaw);
        manager.setPrice(key, num, den);
        stateView.setSqrt(id, _sqrtX96(num, den));
        token.mint(address(manager), 1e27);
        vm.prank(SCREENER);
        pools.addScreenedPool(ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, t0, t1, 500, 10, address(0)));
    }

    /// Both adapters through the registry's timelock: added, then activated, 18 days in all.
    function registerAdapters() internal {
        uint8 add = pools.ADD_ADAPTER();
        uint8 act = pools.ACTIVATE_ADAPTER();
        bytes memory r = abi.encode(ROUTER, address(router));
        bytes memory v = abi.encode(VENUE, address(venue));
        vm.startPrank(admin);
        pools.propose(add, r);
        pools.propose(add, v);
        vm.stopPrank();
        vm.warp(block.timestamp + 9 days);
        pools.execute(add, r);
        pools.execute(add, v);
        vm.startPrank(admin);
        pools.propose(act, abi.encode(ROUTER));
        pools.propose(act, abi.encode(VENUE));
        vm.stopPrank();
        vm.warp(block.timestamp + 9 days);
        pools.execute(act, abi.encode(ROUTER));
        pools.execute(act, abi.encode(VENUE));
        _refreshFeeds();
    }

    /// Every pool's spot price, as the oracle reads it, set to the feeds' prices.
    function pricePools() internal {
        (address u0,) = _sorted(address(usdc), address(wmon));
        if (u0 == address(wmon)) priceV3(poolUsdcWmon, 2e6, 1e18);
        else priceV3(poolUsdcWmon, 1e18, 2e6);
        (address a0,) = _sorted(address(tokA), address(wmon));
        if (a0 == address(tokA)) priceV3(poolAWmon, 3, 1);
        else priceV3(poolAWmon, 1, 3);
        stateView.setSqrt(idMonC, _sqrtX96(5, 1));
        (address b0,) = _sorted(address(tokB), address(usdc));
        stateView.setSqrt(idBUsdc, b0 == address(tokB) ? _sqrtX96(40e6, 1e8) : _sqrtX96(1e8, 40e6));
    }

    /// The price each v3 mock pool was set to, so a fill can be scaled from it.
    mapping(address => uint256) internal baseNum;
    mapping(address => uint256) internal baseDen;

    /// A v3 mock pool at `num` raw token1 per `den` raw token0, for fills and for the oracle alike.
    function priceV3(MockV3Pool p, uint256 num, uint256 den) internal {
        baseNum[address(p)] = num;
        baseDen[address(p)] = den;
        p.setPrice(num, den, _sqrtX96(num, den));
    }

    /// sqrt(token1 per token0, raw) times 2^96.
    function _sqrtX96(uint256 num1, uint256 den0) internal pure returns (uint160) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(Math.sqrt(Math.mulDiv(num1, 2 ** 192, den0)));
    }

    /// Moves the spot the oracle reads from a v3 pool, with what the pool pays unchanged.
    function setSpot(MockV3Pool p, uint256 num, uint256 den) internal {
        p.setPrice(p.num(), p.den(), _sqrtX96(num, den));
    }

    /// Scales what a v3 pool pays for `tokenIn` to `bps` of its price, with the oracle's view of it unchanged.
    function setFill(MockV3Pool p, address tokenIn, uint256 bps) internal {
        (uint256 num, uint256 den, uint160 s) = (baseNum[address(p)], baseDen[address(p)], p.sqrt());
        if (tokenIn == p.token0()) p.setPrice(num * bps / 10_000, den, s);
        else p.setPrice(num, den * bps / 10_000, s);
    }

    /// Moves MON/USD, the USDC/WMON pool with it, and the venue's quote.
    function setMon(int256 answer) internal {
        monUsd.push(answer);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 p = uint256(answer) * 1e10;
        (address u0,) = _sorted(address(usdc), address(wmon));
        if (u0 == address(wmon)) priceV3(poolUsdcWmon, p / 1e12, 1e18);
        else priceV3(poolUsdcWmon, 1e18, p / 1e12);
        venue.setPrice(address(wmon), p);
    }

    // ----- the account -----

    /// Gives the owner `amount` of a token and deposits it.
    function deposit(address token, uint256 amount) internal {
        if (token == address(wmon)) _wmonTo(owner, amount);
        else MockToken(token).mint(owner, amount);
        vm.startPrank(owner);
        IERC20(token).approve(address(account), amount);
        account.deposit(token, amount);
        vm.stopPrank();
    }

    function fund(uint256 usdcAmount, uint256 wmonAmount) internal {
        if (usdcAmount > 0) deposit(address(usdc), usdcAmount);
        if (wmonAmount > 0) deposit(address(wmon), wmonAmount);
    }

    /// Withdraws or deposits down to exact USDC and WMON holdings, for a test that needs a given mix.
    function holdings(uint256 usdcAmount, uint256 wmonAmount) internal {
        uint256 u = usdc.balanceOf(address(account));
        uint256 w = wmon.balanceOf(address(account));
        vm.startPrank(owner);
        if (u > usdcAmount) account.withdraw(address(usdc), u - usdcAmount, owner);
        if (w > wmonAmount) account.withdraw(address(wmon), w - wmonAmount, owner);
        vm.stopPrank();
        if (u < usdcAmount) fund(usdcAmount - u, 0);
        if (w < wmonAmount) fund(0, wmonAmount - w);
    }

    function grant(uint64 validUntil) internal {
        vm.prank(owner);
        executor.registerSession(AGENT, session, validUntil);
    }

    function optIn() internal {
        vm.prank(owner);
        account.setScreenedOptIn(true);
    }

    // ----- timelocks -----

    /// After a warp: fresh feeds and a fresh session grant.
    function afterWarp() internal {
        _refreshFeeds();
        grant(uint64(block.timestamp + 7 days));
    }

    function timelockedExecutor(uint8 action, bytes memory data) internal {
        vm.prank(admin);
        executor.propose(action, data);
        vm.warp(block.timestamp + 9 days);
        executor.execute(action, data);
        afterWarp();
    }

    function timelockedRegistry(uint8 action, bytes memory data) internal {
        vm.prank(admin);
        tokens.propose(action, data);
        vm.warp(block.timestamp + 9 days);
        tokens.execute(action, data);
        afterWarp();
    }

    /// The mock attestor becomes the registry's verifier: class A tokens may trade.
    function setAttestor() internal {
        timelockedRegistry(tokens.SET_VERIFIER(), abi.encode(address(attestor)));
    }

    function tighten(PolicyV3 memory p) internal {
        vm.prank(guardian);
        executor.tightenPolicy(p);
    }

    // ----- prices, routes and intents -----

    function isClassA(address token) internal view returns (bool) {
        return tokens.tokenRecord(token).priceClass == PriceClass.A;
    }

    /// The price the Executor uses for a side: USDC 1, a class F token's feed, a class A token's reference.
    function px(address token) internal view returns (uint256) {
        if (token == address(usdc)) return PX_USDC;
        if (isClassA(token)) return refPrice[token];
        return oracle.priceE18(token);
    }

    function dec(address token) internal view returns (uint8) {
        return tokens.tokenRecord(token).decimals;
    }

    function slippageFor(address tokenIn, address tokenOut) internal view returns (uint256) {
        return isClassA(tokenIn) || isClassA(tokenOut) ? 100 : 50;
    }

    /// The least minAmountOut the Executor accepts for this trade now.
    function floorFor(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (uint256) {
        return executor.floorFor(
            amountIn, px(tokenIn), dec(tokenIn), px(tokenOut), dec(tokenOut), slippageFor(tokenIn, tokenOut)
        );
    }

    /// The output the prices imply, which the mock pools pay exactly.
    function impliedFor(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (uint256) {
        return executor.impliedOut(amountIn, px(tokenIn), dec(tokenIn), px(tokenOut), dec(tokenOut));
    }

    /// The hub a token's own pool connects it to: WMON for A and C, USDC for B, D, E and F.
    function hub(address token) internal view returns (address) {
        if (token == address(usdc) || token == address(wmon)) return token;
        if (token == address(tokA) || token == address(tokC)) return address(wmon);
        return address(usdc);
    }

    function leg(address token) internal view returns (bytes32) {
        if (token == address(tokA)) return idAWmon;
        if (token == address(tokC)) return idMonC;
        if (token == address(tokB)) return idBUsdc;
        if (token == address(tokE)) return idUsdcE;
        if (token == address(tokF)) return idUsdcF;
        return idUsdcD;
    }

    /// The natural route between two tokens through the mock pools: at most three hops.
    function routeFor(address tokenIn, address tokenOut) internal view returns (bytes32[] memory r) {
        bytes32[3] memory hops;
        uint256 n;
        address at = tokenIn;
        if (hub(tokenIn) != tokenIn) {
            hops[n++] = leg(tokenIn);
            at = hub(tokenIn);
        }
        if (at != hub(tokenOut)) hops[n++] = idUsdcWmon;
        if (hub(tokenOut) != tokenOut) hops[n++] = leg(tokenOut);
        r = new bytes32[](n);
        for (uint256 k = 0; k < n; ++k) {
            r[k] = hops[k];
        }
    }

    /// A valid intent at the current epochs and policy, deadline two minutes out, through the RouteAdapter.
    function intentWith(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes32[] memory route)
        internal
        returns (SwapIntentV3 memory i)
    {
        i = SwapIntentV3({
            schemaVersion: 2,
            chainId: block.chainid,
            agentId: AGENT,
            account: address(account),
            actionId: keccak256(abi.encode("action", ++actionCounter)),
            ownerEpoch: nft.ownerEpoch(AGENT),
            configEpoch: executor.configEpochOf(AGENT),
            policyHash: executor.policyHash(),
            adapterId: ROUTER,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minOut,
            deadline: uint64(block.timestamp + 120),
            route: route,
            attestationIn: "",
            attestationOut: ""
        });
    }

    function intent(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        internal
        returns (SwapIntentV3 memory)
    {
        return intentWith(tokenIn, tokenOut, amountIn, minOut, routeFor(tokenIn, tokenOut));
    }

    /// One attestation for a token at a price, valid for a minute.
    function attestation(address token, uint256 priceE18) internal returns (bytes memory) {
        attestor.set(token, priceE18, uint64(block.timestamp + ATTESTATION_LIFE));
        return abi.encode(token);
    }

    /// Fresh attestations at the reference prices for each class A side.
    function attest(SwapIntentV3 memory i) internal {
        if (isClassA(i.tokenIn)) i.attestationIn = attestation(i.tokenIn, refPrice[i.tokenIn]);
        if (isClassA(i.tokenOut)) i.attestationOut = attestation(i.tokenOut, refPrice[i.tokenOut]);
    }

    /// A trade at the oracle floor, attested where a side is class A.
    function trade(address tokenIn, address tokenOut, uint256 amountIn) internal returns (SwapIntentV3 memory i) {
        i = intent(tokenIn, tokenOut, amountIn, floorFor(tokenIn, tokenOut, amountIn));
        attest(i);
    }

    function buy(uint256 usdcIn) internal returns (SwapIntentV3 memory) {
        return trade(address(usdc), address(wmon), usdcIn);
    }

    function sell(uint256 wmonIn) internal returns (SwapIntentV3 memory) {
        return trade(address(wmon), address(usdc), wmonIn);
    }

    function submit(SwapIntentV3 memory i) internal returns (uint256) {
        vm.prank(session);
        return executor.swap(i);
    }

    function expectRejected(SwapIntentV3 memory i, ReasonV3 r) internal {
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, r));
        executor.swap(i);
    }

    function routeHash(bytes32[] memory route) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(route));
    }

    // ----- reads -----

    function bal(address token, address who) internal view returns (uint256) {
        return IERC20(token).balanceOf(who);
    }

    function usdcOf(address who) internal view returns (uint256) {
        return usdc.balanceOf(who);
    }

    function wmonOf(address who) internal view returns (uint256) {
        return wmon.balanceOf(who);
    }

    function assertMode(AccountMode m) internal view {
        assertEq(uint8(account.mode()), uint8(m));
    }

    /// Nothing of any token the stack touched stays with the Executor or the adapters.
    function assertNothingKept() internal view {
        address[8] memory all = [
            address(usdc),
            address(wmon),
            address(tokA),
            address(tokB),
            address(tokC),
            address(tokD),
            address(tokE),
            address(tokF)
        ];
        for (uint256 k = 0; k < all.length; ++k) {
            assertEq(bal(all[k], address(executor)), 0, "the Executor kept funds");
            assertEq(bal(all[k], address(router)), 0, "the RouteAdapter kept funds");
        }
    }
}
