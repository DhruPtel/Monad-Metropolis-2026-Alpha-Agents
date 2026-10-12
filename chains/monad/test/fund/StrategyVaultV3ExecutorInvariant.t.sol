// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {AccountFactoryV3} from "../../src/fund/AccountFactoryV3.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {ExecutorV3} from "../../src/fund/ExecutorV3.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {StrategyVaultV3} from "../../src/fund/StrategyVaultV3.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {ReasonV3, SwapIntentV3} from "../../src/interfaces/IExecutorV3.sol";
import {FeedConfig, PriceClass, PriceReason, Venue} from "../../src/interfaces/IFund.sol";
import {MockAgentNFT, MockToken} from "../mocks/CustodyMocks.sol";
import {MockRouteAdapter} from "../mocks/ExecutorV3Mocks.sol";
import {MockV3Pool} from "../mocks/FundMocks.sol";
import {MockFeed} from "../mocks/OracleMocks.sol";
import {ExecutorV3Base} from "./ExecutorV3Base.sol";

/// P7-U3: the vault through the real Executor v3 and RouteAdapter over six
/// class F tokens (the base's four and two more, each added through the token
/// and pool registries' timelocks), driven by a session key trading every pair
/// through the real pools or a venue that misbehaves one call in eight, three
/// depositors and the leader with their flows, the sentinel and the guardian
/// tightening, the manager loosening, a buyer taking the agent over, an oracle
/// mover and a pool mover, time, and strangers. Every trade is checked against
/// the hard limits and the vault's backstops as it happens; the invariants hold
/// the exits, the shares, the stake, the locks and the handover.
contract VaultExecutorHandler is Test {
    StrategyVaultV3ExecutorInvariantTest internal t;
    ExecutorV3 internal executor;
    StrategyVaultV3 internal sv;
    MockRouteAdapter internal venue;
    MockAgentNFT internal nft;
    OracleAdapterV3 internal oracle;
    address[6] internal toks;
    address internal usdc;
    address[5] internal actors; // the first leader, three depositors, the buyer
    address internal session;
    address internal sentinel;
    address internal guardian;
    address internal stranger = makeAddr("stranger");
    uint256 internal agent;

    address public immutable SINK = makeAddr("exit recipient");

    mapping(address => int256) public expected;
    mapping(address => uint256) public sharesAtOwnFlow;
    uint256 public trades;
    uint256 public refused;
    uint256 public deposits;
    uint256 public exits;
    uint256 public inKindExits;
    uint256 public sales;
    uint256 public acceptances;
    uint256 public calls;
    bool public violated;
    string public violation;

    struct Done {
        uint256 at;
        uint256 value;
    }

    Done[] internal done;

    constructor(
        StrategyVaultV3ExecutorInvariantTest base,
        ExecutorV3 e,
        StrategyVaultV3 v,
        MockRouteAdapter venue_,
        MockAgentNFT n,
        address[6] memory tokens_,
        address[5] memory actors_,
        address[3] memory keys
    ) {
        t = base;
        executor = e;
        sv = v;
        venue = venue_;
        nft = n;
        toks = tokens_;
        usdc = tokens_[0];
        actors = actors_;
        session = keys[0];
        sentinel = keys[1];
        guardian = keys[2];
        agent = sv.agentId();
        oracle = OracleAdapterV3(address(executor.factory().oracle()));
        for (uint256 k = 0; k < 6; ++k) {
            expected[toks[k]] = int256(IERC20(toks[k]).balanceOf(address(sv)));
        }
        for (uint256 i = 0; i < actors.length; ++i) {
            MockToken(usdc).mint(actors[i], 1e12);
            vm.prank(actors[i]);
            IERC20(usdc).approve(address(sv), type(uint256).max);
            sharesAtOwnFlow[actors[i]] = sv.sharesOf(actors[i]);
        }
    }

    function actorList() external view returns (address[5] memory) {
        return actors;
    }

    function tokenList() external view returns (address[6] memory) {
        return toks;
    }

    function _fail(string memory why) internal {
        if (!violated) {
            violated = true;
            violation = why;
        }
    }

    function _manager() internal view returns (address) {
        return sv.manager();
    }

    /// The price per share at the cached prices after a fresh poke; zero when a feed is unusable.
    function _pokedPrice() internal returns (uint256 price, bool ok) {
        try sv.poke() {
            return (sv.sharePriceE18(), true);
        } catch {
            return (0, false);
        }
    }

    /// A flow never lowers the price per share for the others, within one unit of
    /// each held token's valuation rounding (an in-kind exit floors each slice).
    function _checkFlow(address who, uint256 before, bool priced) internal {
        uint256 supply = sv.totalSupply();
        if (priced && supply != 0) {
            uint256 tolerance = (sv.heldCount() + 1) * 1e30 / supply + 1;
            if (sv.sharePriceE18() + tolerance < before) _fail("a flow lowered the price per share");
        }
        sharesAtOwnFlow[who] = sv.sharesOf(who);
    }

    // ----- the depositors and the leader -----

    function deposit(uint256 seed, uint256 amount) external {
        calls++;
        address who = seed % 4 == 0 ? _manager() : actors[1 + seed % 3];
        if (who == address(0)) return;
        amount = bound(amount, 1, 500e6);
        (uint256 before, bool priced) = _pokedPrice();
        uint256 preview = sv.convertToShares(amount);
        uint256 usdcBefore = IERC20(usdc).balanceOf(address(sv));
        vm.prank(who);
        try sv.deposit(amount, 0) returns (uint256 shares) {
            // Previews equal results at the same prices (M-34).
            if (priced && shares != preview) _fail("the deposit minted other than its preview");
            expected[usdc] += int256(IERC20(usdc).balanceOf(address(sv)) - usdcBefore);
            deposits++;
            _checkFlow(who, before, priced);
        } catch {}
    }

    function redeem(uint256 seed, uint256 part) external {
        calls++;
        address who = actors[seed % 5];
        uint256 held = sv.sharesOf(who);
        if (held == 0) return;
        uint256 shares = bound(part, 1, held);
        (uint256 before, bool priced) = _pokedPrice();
        uint256 preview = sv.convertToAssets(shares);
        uint256 usdcBefore = IERC20(usdc).balanceOf(address(sv));
        vm.prank(who);
        try sv.redeem(shares, SINK, 0, uint64(block.timestamp + 60)) returns (uint256 assets) {
            if (priced && assets != preview) _fail("the USDC exit paid other than its preview");
            expected[usdc] -= int256(usdcBefore - IERC20(usdc).balanceOf(address(sv)));
            exits++;
            _checkFlow(who, before, priced);
        } catch {}
    }

    function redeemInKind(uint256 seed, uint256 part) external {
        calls++;
        address who = actors[seed % 5];
        uint256 held = sv.sharesOf(who);
        if (held == 0) return;
        uint256 shares = bound(part, 1, held);
        (uint256 before, bool priced) = _pokedPrice();
        (address[] memory heldTokens, uint256[] memory preview) = sv.inKindAmounts(shares);
        uint256[6] memory bal;
        for (uint256 k = 0; k < 6; ++k) {
            bal[k] = IERC20(toks[k]).balanceOf(address(sv));
        }
        vm.prank(who);
        try sv.redeemInKind(shares, SINK) {
            for (uint256 k = 0; k < 6; ++k) {
                uint256 paid = bal[k] - IERC20(toks[k]).balanceOf(address(sv));
                uint256 idx = _indexIn(heldTokens, toks[k]);
                if (idx == type(uint256).max ? paid != 0 : paid != preview[idx]) {
                    _fail("an in-kind exit paid other than the previewed floor");
                }
                expected[toks[k]] -= int256(paid);
            }
            inKindExits++;
            _checkFlow(who, before, priced);
        } catch {}
    }

    function _indexIn(address[] memory list, address token) internal pure returns (uint256) {
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i] == token) return i;
        }
        return type(uint256).max;
    }

    // ----- the session key trades for the vault -----

    struct Attempt {
        address tokenIn;
        address tokenOut;
        uint256 pxIn;
        uint256 pxOut;
        uint8 decIn;
        uint8 decOut;
        uint256 capped;
        uint256 navBefore;
        uint256 amountIn;
        uint256 value;
        uint256 floor;
        uint256 minOut;
        uint256 inBefore;
        uint256 outBefore;
        uint256 supply;
        address from;
    }

    function trade(uint256 seed, uint8 pair, uint256 sizeBps, uint256 slip, uint8 behaviour, uint8 sender) external {
        calls++;
        Attempt memory a;
        a.tokenIn = toks[pair % 6];
        a.tokenOut = toks[(pair / 6) % 6];
        if (a.tokenIn == a.tokenOut) a.tokenOut = toks[(pair / 6 + 1) % 6];
        PriceReason r1;
        PriceReason r2;
        (a.pxIn,, r1) = oracle.price(a.tokenIn);
        (a.pxOut,, r2) = oracle.price(a.tokenOut);
        if (r1 != PriceReason.OK || r2 != PriceReason.OK) return;
        a.decIn = t.decimalsOf(a.tokenIn);
        a.decOut = t.decimalsOf(a.tokenOut);
        try sv.capValues() returns (uint256 c, uint256, uint256) {
            a.capped = c;
        } catch {
            return;
        }
        try sv.navUsdc() returns (uint256 n) {
            a.navBefore = n;
        } catch {
            return;
        }
        uint256 v = a.capped * bound(sizeBps, 1, seed % 2 == 0 ? 100 : 1_300) / 10_000;
        a.amountIn = v * (10 ** (uint256(a.decIn) + 12)) / a.pxIn;
        if (a.amountIn == 0) return;
        a.value = a.amountIn * a.pxIn / (10 ** (uint256(a.decIn) + 12));
        a.floor = executor.floorFor(a.amountIn, a.pxIn, a.decIn, a.pxOut, a.decOut, 50);
        if (a.floor == 0) return;
        a.minOut = slip % 4 == 0 && a.floor > 1 ? a.floor - 1 : a.floor;
        venue.setBehaviour(MockRouteAdapter.Behaviour(behaviour % 64 < 8 ? behaviour % 10 : 0), "");
        venue.setOutputBps(9_950 + seed % 100);
        a.from = sender % 5 == 0 ? _manager() : sender % 7 == 0 ? stranger : session;
        if (a.from == address(0)) a.from = stranger;
        a.inBefore = IERC20(a.tokenIn).balanceOf(address(sv));
        a.outBefore = IERC20(a.tokenOut).balanceOf(address(sv));
        a.supply = sv.totalSupply();
        SwapIntentV3 memory i = t.makeVaultIntent(a.tokenIn, a.tokenOut, a.amountIn, a.minOut);
        if (behaviour % 4 == 0) i.adapterId = keccak256("mock venue");
        vm.prank(a.from);
        try executor.swap(i) returns (uint256) {
            _record(a);
        } catch {
            ++refused;
        }
        venue.setBehaviour(MockRouteAdapter.Behaviour.Honest, "");
    }

    function _record(Attempt memory a) internal {
        uint256 inAfter = IERC20(a.tokenIn).balanceOf(address(sv));
        uint256 outAfter = IERC20(a.tokenOut).balanceOf(address(sv));
        if (a.from != session) _fail("a trade from someone other than the session key");
        if (a.inBefore - inAfter > a.amountIn) _fail("more than amountIn left the vault");
        if (a.inBefore - inAfter == 0) _fail("nothing left the vault for a trade");
        if (outAfter - a.outBefore < a.minOut) _fail("less than minAmountOut arrived");
        if (a.value * 10_000 > a.capped * 1_000) _fail("a trade above 10% of value");
        if (a.minOut < a.floor) _fail("a minimum below the oracle floor");
        if (sv.totalSupply() != a.supply) _fail("a trade touched the shares");
        if (sv.inHandover()) _fail("a trade went through in handover");
        _checkPost(a);
        _checkWindow(a.value, a.capped);
        expected[a.tokenIn] += int256(inAfter) - int256(a.inBefore);
        expected[a.tokenOut] += int256(outAfter) - int256(a.outBefore);
        done.push(Done(block.timestamp, a.value));
        ++trades;
    }

    /// The Executor's caps after a buy, the vault's own backstops, and the loss bound (per trade).
    function _checkPost(Attempt memory a) internal {
        uint256 navAfter = sv.navUsdc();
        // The value that left came back within the slippage limit plus the pools' fees (the
        // core's own backstop is 1%): per-trade loss bounded.
        if (navAfter + a.value / 100 + 1 < a.navBefore) _fail("a trade lost more than the slippage limit");
        if (a.tokenOut == usdc) return;
        (uint256 capped,,) = sv.capValues();
        uint256 held = sv.freeBalance(a.tokenOut) * a.pxOut / (10 ** (uint256(a.decOut) + 12));
        if (held * 10_000 > capped * 4_000) _fail("over 40% in one token after a buy");
        if (held * 10_000 > capped * 4_500) _fail("over the vault's 45% backstop after a buy");
        if (sv.freeBalance(usdc) * 10_000 < navAfter * 1_000) _fail("under the USDC floor after a buy");
    }

    function _checkWindow(uint256 value, uint256 capped) internal {
        uint256 count;
        uint256 turnover = value;
        for (uint256 k = 0; k < done.length; ++k) {
            if (done[k].at + 86_400 > block.timestamp) {
                ++count;
                turnover += done[k].value;
            }
        }
        if (count >= 20) _fail("a 21st trade in 24 hours");
        if (turnover > capped) _fail("turnover above 100% of value");
    }

    // ----- the oracle mover, the pool mover, time -----

    function oracleMove(uint8 which, uint256 bps) external {
        calls++;
        t.moveToken(which % 4, bound(bps, 9_700, 10_300));
    }

    function poolMove(uint8 which, uint256 spotBps, uint256 fillBps) external {
        calls++;
        t.movePool(which % 4, bound(spotBps, 9_750, 10_250), bound(fillBps, 9_950, 10_050));
    }

    function pokeReference() external {
        calls++;
        try sv.pokeReference() {} catch {}
    }

    function wait(uint256 secs) external {
        calls++;
        vm.warp(block.timestamp + bound(secs, 0, 2 hours));
        t.refresh();
    }

    // ----- the tighteners, the manager, the buyer -----

    function emergency(uint8 which) external {
        calls++;
        if (which % 4 == 0) {
            vm.prank(sentinel);
            try sv.setReduceOnly() {} catch {}
        } else if (which % 4 == 1) {
            vm.prank(guardian);
            try sv.pause() {} catch {}
        } else if (which % 4 == 2) {
            vm.prank(sentinel);
            try sv.closeDeposits() {} catch {}
        } else {
            address m = _manager();
            if (m == address(0)) return;
            vm.startPrank(m);
            try sv.unpause() {} catch {}
            sv.openDeposits();
            vm.stopPrank();
        }
    }

    function manager(uint8 which, uint256 value) external {
        calls++;
        address m = _manager();
        if (m == address(0)) return;
        vm.startPrank(m);
        if (which % 3 == 0) {
            try sv.setDepositsOpen(value % 5 != 0) {} catch {}
        } else if (which % 3 == 1) {
            try sv.setLockup(uint64(bound(value, 1 days, 7 days))) {} catch {}
        } else {
            try sv.applyLockup() {} catch {}
        }
        vm.stopPrank();
    }

    function sale(uint256 seed) external {
        calls++;
        if (seed % 12 != 0) return;
        address current = nft.ownerOf(agent);
        nft.setOwner(agent, current == actors[4] ? actors[0] : actors[4]);
        sales++;
        // The new owner registers the vault grant for the same key: trades still wait for acceptance.
        vm.prank(nft.ownerOf(agent));
        try executor.registerVaultSession(agent, session) {} catch {}
    }

    function stakeAndAccept(uint256 amount) external {
        calls++;
        if (!sv.inHandover()) return;
        address agentOwner = nft.ownerOf(agent);
        amount = bound(amount, 1e6, 5_000e6);
        uint256 usdcBefore = IERC20(usdc).balanceOf(address(sv));
        vm.prank(agentOwner);
        try sv.stakeAsIncomingLeader(amount, 0) {
            expected[usdc] += int256(IERC20(usdc).balanceOf(address(sv)) - usdcBefore);
            deposits++;
            sharesAtOwnFlow[agentOwner] = sv.sharesOf(agentOwner);
        } catch {}
        vm.warp(block.timestamp + 3 days);
        t.refresh();
        address previous = sv.leader();
        vm.prank(agentOwner);
        try sv.acceptManagement() {
            acceptances++;
            sharesAtOwnFlow[previous] = sv.sharesOf(previous);
            sharesAtOwnFlow[agentOwner] = sv.sharesOf(agentOwner);
            vm.prank(agentOwner);
            try executor.registerVaultSession(agent, session) {} catch {}
        } catch {}
    }

    // ----- everyone else -----

    function intrude(uint256 actorSeed, uint256 which, uint256 amount) external {
        calls++;
        address m = _manager();
        address[6] memory candidates = [stranger, guardian, sentinel, session, actors[1], actors[4]];
        address actor = candidates[actorSeed % 6];
        if (actor == m) return;
        address tok = toks[amount % 6];
        amount = bound(amount, 1, 100e18);
        bytes memory data;
        uint256 w = which % 8;
        if (w == 0) data = abi.encodeCall(CustodyCoreV3.withdraw, (tok, amount, actor));
        else if (w == 1) data = abi.encodeCall(CustodyCoreV3.withdrawAll, (actor));
        else if (w == 2) data = abi.encodeCall(CustodyCoreV3.pullForSwap, (tok, amount));
        else if (w == 3) data = abi.encodeCall(StrategyVaultV3.initialize, (agent, actor));
        else if (w == 4) data = abi.encodeCall(StrategyVaultV3.setDepositsOpen, (true));
        else if (w == 5) data = abi.encodeCall(StrategyVaultV3.closeVault, ());
        else if (w == 6) data = abi.encodeCall(CustodyCoreV3.unpause, ());
        else data = abi.encodeCall(StrategyVaultV3.setLockup, (uint64(1 days)));
        vm.prank(actor);
        (bool ok,) = address(sv).call(data);
        if (ok) _fail(string.concat("an intruder's call ", vm.toString(w), " went through"));
    }
}

contract StrategyVaultV3ExecutorInvariantTest is ExecutorV3Base {
    VaultExecutorHandler internal handler;
    StrategyVaultV3 internal sv;
    MockToken[2] internal xToks;
    MockFeed[2] internal xFeeds;
    MockV3Pool[2] internal xPools;
    bytes32[2] internal idUsdcX;
    int256[2] internal xAnswers = [int256(1e8), int256(1e8)];
    int256 internal currentMon = 2e8;
    int256 internal currentA = 6e8;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal buyer = makeAddr("buyer");

    function setUp() public override {
        super.setUp();
        _addTwoCoreTokensWithPools();
        vm.startPrank(admin);
        factory.addDepositor(alice);
        factory.addDepositor(bob);
        factory.addDepositor(carol);
        factory.addDepositor(buyer);
        vm.stopPrank();
        vm.prank(owner);
        sv = StrategyVaultV3(factory.createVault(AGENT));
        usdc.mint(owner, 10_000e6);
        vm.startPrank(owner);
        usdc.approve(address(sv), type(uint256).max);
        sv.deposit(1_000e6, 0);
        sv.setDepositsOpen(true);
        executor.registerVaultSession(AGENT, session);
        vm.stopPrank();
        handler = new VaultExecutorHandler(
            this,
            executor,
            sv,
            venue,
            nft,
            [address(usdc), address(wmon), address(tokA), address(tokB), address(xToks[0]), address(xToks[1])],
            [owner, alice, bob, carol, buyer],
            [session, sentinel, guardian]
        );
        targetContract(address(handler));
    }

    /// Two more core class F tokens at 1 USDC, each with a Uniswap v3 mock pool
    /// against USDC, through the token registry's and the pool registry's timelocks.
    function _addTwoCoreTokensWithPools() internal {
        bytes[] memory tokenPayloads = new bytes[](2);
        bytes[] memory poolPayloads = new bytes[](2);
        uint8 addCore = tokens.ADD_CORE();
        uint8 addPool = pools.ADD_CORE_POOL();
        for (uint256 k = 0; k < 2; ++k) {
            xToks[k] = new MockToken(string.concat("X", vm.toString(k)), 18);
            xFeeds[k] = new MockFeed(8);
            xFeeds[k].push(1e8);
            (address a0, address a1) = _sorted(address(xToks[k]), address(usdc));
            xPools[k] = new MockV3Pool(a0, a1, 3_000, 60);
            uniFactory.setPool(a0, a1, 3_000, address(xPools[k]));
            // 1 X (1e18) is 1 USDC (1e6): raw token1 per raw token0.
            if (a0 == address(xToks[k])) priceV3(xPools[k], 1e6, 1e18);
            else priceV3(xPools[k], 1e18, 1e6);
            xToks[k].mint(address(xPools[k]), 1e27);
            usdc.mint(address(xPools[k]), 1e15);
            xToks[k].mint(address(venue), 1e27);
            venue.setPrice(address(xToks[k]), 1e18);
            tokenPayloads[k] = abi.encode(
                TokenRegistry.CoreSeed(
                    address(xToks[k]), PriceClass.F, 4_500, FeedConfig(_feed(xFeeds[k], 8, 3_900), _noLeg())
                )
            );
            poolPayloads[k] =
                abi.encode(ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V3, a0, a1, 3_000, 60, address(xPools[k])));
            vm.prank(admin);
            tokens.propose(addCore, tokenPayloads[k]);
        }
        vm.warp(block.timestamp + 9 days);
        for (uint256 k = 0; k < 2; ++k) {
            tokens.execute(addCore, tokenPayloads[k]);
            vm.prank(admin);
            pools.propose(addPool, poolPayloads[k]);
        }
        vm.warp(block.timestamp + 9 days);
        for (uint256 k = 0; k < 2; ++k) {
            pools.execute(addPool, poolPayloads[k]);
            idUsdcX[k] = pools.poolIdOf(abi.decode(poolPayloads[k], (ProtocolRegistryV3.PoolSeed)));
        }
        refresh();
    }

    // ----- for the handler -----

    /// The pools from USDC out to a token: the base's hubs, or an X's own pool.
    function _legs(address token) internal view returns (bytes32[] memory r) {
        if (token == address(usdc)) return new bytes32[](0);
        if (token == address(xToks[0]) || token == address(xToks[1])) {
            r = new bytes32[](1);
            r[0] = token == address(xToks[0]) ? idUsdcX[0] : idUsdcX[1];
            return r;
        }
        if (token == address(wmon)) {
            r = new bytes32[](1);
            r[0] = idUsdcWmon;
        } else if (token == address(tokB)) {
            r = new bytes32[](1);
            r[0] = idBUsdc;
        } else {
            r = new bytes32[](2);
            (r[0], r[1]) = (idUsdcWmon, idAWmon);
        }
    }

    /// The route between two tokens through USDC, the shared prefix dropped so no token repeats.
    function vaultRoute(address tokenIn, address tokenOut) public view returns (bytes32[] memory r) {
        bytes32[] memory a = _legs(tokenIn);
        bytes32[] memory b = _legs(tokenOut);
        uint256 common;
        while (common < a.length && common < b.length && a[common] == b[common]) {
            ++common;
        }
        r = new bytes32[]((a.length - common) + (b.length - common));
        uint256 n;
        for (uint256 k = a.length; k > common; --k) {
            r[n++] = a[k - 1];
        }
        for (uint256 k = common; k < b.length; ++k) {
            r[n++] = b[k];
        }
    }

    function makeVaultIntent(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        returns (SwapIntentV3 memory i)
    {
        i = intentWith(tokenIn, tokenOut, amountIn, minOut, vaultRoute(tokenIn, tokenOut));
        i.account = address(sv);
    }

    function decimalsOf(address token) external view returns (uint8) {
        return dec(token);
    }

    /// Fresh rounds on every feed at its current answer.
    function refresh() public {
        setMon(currentMon);
        usdcUsd.push(1e8);
        aUsd.push(currentA);
        // forge-lint: disable-next-line(unsafe-typecast)
        bRate.push(int256(40e18 * 1e18 / (uint256(currentMon) * 1e10)));
        for (uint256 k = 0; k < 2; ++k) {
            xFeeds[k].push(xAnswers[k]);
        }
    }

    /// Moves one token's feed by `bps` and its pools with it, so trades stay inside the oracle's bound.
    function moveToken(uint256 which, uint256 bps) external {
        if (which == 0) {
            currentMon = currentMon * int256(bps) / 10_000;
            if (currentMon < 1e7) currentMon = 1e7;
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 p = uint256(currentMon) * 1e10;
            (address a0,) = _sorted(address(tokA), address(wmon));
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 pa = uint256(currentA) * 1e10;
            if (a0 == address(tokA)) priceV3(poolAWmon, pa, p);
            else priceV3(poolAWmon, p, pa);
        } else if (which == 1) {
            currentA = currentA * int256(bps) / 10_000;
            if (currentA < 1e7) currentA = 1e7;
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 pa = uint256(currentA) * 1e10;
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 p = uint256(currentMon) * 1e10;
            (address a0,) = _sorted(address(tokA), address(wmon));
            if (a0 == address(tokA)) priceV3(poolAWmon, pa, p);
            else priceV3(poolAWmon, p, pa);
            venue.setPrice(address(tokA), pa);
        } else {
            uint256 k = which - 2;
            xAnswers[k] = xAnswers[k] * int256(bps) / 10_000;
            if (xAnswers[k] < 1e7) xAnswers[k] = 1e7;
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 px = uint256(xAnswers[k]) * 1e10;
            (address a0,) = _sorted(address(xToks[k]), address(usdc));
            // raw USDC (6) per raw X (18): px / 1e12 per 1e18 X.
            if (a0 == address(xToks[k])) priceV3(xPools[k], px / 1e12, 1e18);
            else priceV3(xPools[k], 1e18, px / 1e12);
            venue.setPrice(address(xToks[k]), px);
        }
        refresh();
    }

    /// Moves a pool's spot off its feed by `spotBps` (the oracle may refuse it) and its fill by `fillBps`.
    function movePool(uint256 which, uint256 spotBps, uint256 fillBps) external {
        MockV3Pool p = which == 0 ? poolUsdcWmon : which == 1 ? poolAWmon : xPools[which - 2];
        uint256 num = baseNum[address(p)];
        uint256 den = baseDen[address(p)];
        setSpot(p, num * spotBps / 10_000, den);
        setFill(p, p.token0(), fillBps);
    }

    // ----- invariants -----

    /// M-13 over the run: with the vault paused and the oracle, the registries,
    /// the factory, the Executor, the router, the venue and AgentNFT all
    /// replaced by reverting code, every holder leaves in kind for the floor of
    /// every held token's slice.
    function invariant_EveryoneLeavesInKindWithEverythingElseReverting() public {
        uint256 snap = vm.snapshotState();
        vm.prank(guardian);
        try sv.pause() {} catch {}
        bytes memory dead = hex"60006000fd";
        vm.etch(address(oracle), dead);
        vm.etch(address(tokens), dead);
        vm.etch(address(pools), dead);
        vm.etch(address(factory), dead);
        vm.etch(address(executor), dead);
        vm.etch(address(router), dead);
        vm.etch(address(venue), dead);
        vm.etch(address(nft), dead);
        address[5] memory a = handler.actorList();
        address[6] memory toks = handler.tokenList();
        address sink = handler.SINK();
        for (uint256 i = 0; i < a.length; ++i) {
            uint256 held = sv.sharesOf(a[i]);
            if (held == 0) continue;
            (address[] memory heldTokens, uint256[] memory preview) = sv.inKindAmounts(held);
            uint256[6] memory sinkBefore;
            for (uint256 k = 0; k < 6; ++k) {
                sinkBefore[k] = IERC20(toks[k]).balanceOf(sink);
            }
            vm.prank(a[i]);
            sv.redeemInKind(held, sink);
            for (uint256 k = 0; k < 6; ++k) {
                uint256 paid = IERC20(toks[k]).balanceOf(sink) - sinkBefore[k];
                uint256 idx = _indexIn(heldTokens, toks[k]);
                assertEq(paid, idx == type(uint256).max ? 0 : preview[idx], "the floor of the slice");
            }
            assertEq(sv.sharesOf(a[i]), 0);
        }
        assertEq(sv.totalSupply(), 0, "everyone left");
        vm.revertToState(snap);
    }

    function _indexIn(address[] memory list, address token) internal pure returns (uint256) {
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i] == token) return i;
        }
        return type(uint256).max;
    }

    function invariant_NoLimitOrBackstopWasBroken() public view {
        assertFalse(handler.violated(), handler.violation());
    }

    function invariant_TheExecutorAndTheRouterKeepNothing() public view {
        assertNothingKept();
        address[6] memory toks = handler.tokenList();
        for (uint256 k = 0; k < 6; ++k) {
            assertEq(IERC20(toks[k]).balanceOf(address(executor)), 0, "the Executor kept funds");
            assertEq(IERC20(toks[k]).balanceOf(address(router)), 0, "the router kept funds");
        }
    }

    function invariant_TheVaultsBalancesAreExactlyItsFlowsAndTrades() public view {
        address[6] memory toks = handler.tokenList();
        for (uint256 k = 0; k < 6; ++k) {
            assertEq(int256(IERC20(toks[k]).balanceOf(address(sv))), handler.expected(toks[k]));
        }
    }

    function invariant_TheSupplyIsTheSumOfShares() public view {
        address[5] memory a = handler.actorList();
        uint256 sum = sv.leaderShares() + sv.incomingShares();
        for (uint256 i = 0; i < a.length; ++i) {
            sum += sv.balanceOf(a[i]);
        }
        assertEq(sv.totalSupply(), sum);
    }

    /// A holder's shares change only through their own flows.
    function invariant_NoValueMovesBetweenDepositors() public view {
        address[5] memory a = handler.actorList();
        for (uint256 i = 0; i < a.length; ++i) {
            assertEq(sv.sharesOf(a[i]), handler.sharesAtOwnFlow(a[i]), "shares moved without an own flow");
        }
    }

    function invariant_TheLeaderStakeHolds() public view {
        if (sv.totalSupply() == 0 || sv.inHandover()) return;
        assertGe(sv.leaderShares() * 10_000, 500 * sv.totalSupply(), "the leader fell below 5%");
    }

    /// Locks end within the hard maximum, and a locked holder cannot leave until then.
    function invariant_LockupsHold() public {
        address[5] memory a = handler.actorList();
        for (uint256 i = 0; i < a.length; ++i) {
            uint256 held = sv.sharesOf(a[i]);
            if (held == 0) continue;
            (, uint64 unlockAt) = sv.lockOf(a[i]);
            if (unlockAt > block.timestamp) assertLe(unlockAt, block.timestamp + 7 days, "a lock beyond the maximum");
            uint256 free = sv.freeShares(a[i]);
            if (free < held) {
                vm.prank(a[i]);
                (bool ok,) = address(sv).call(abi.encodeCall(StrategyVaultV3.redeemInKind, (free + 1, a[i])));
                assertFalse(ok, "a locked holder left early");
            }
        }
    }

    /// In handover nobody manages, nobody deposits, nothing trades, and everyone may leave.
    function invariant_HandoverHolds() public {
        if (!sv.inHandover()) return;
        assertEq(sv.manager(), address(0));
        address[5] memory a = handler.actorList();
        vm.prank(a[1]);
        (bool deposited,) = address(sv).call(abi.encodeCall(StrategyVaultV3.deposit, (1e6, 0)));
        assertFalse(deposited, "a deposit went through in handover");
        SwapIntentV3 memory i = this.makeVaultIntent(address(usdc), address(wmon), 1e6, 1);
        vm.prank(session);
        (bool traded, bytes memory ret) = address(executor).call(abi.encodeCall(ExecutorV3.swap, (i)));
        assertFalse(traded, "a trade went through in handover");
        if (ret.length == 36 && bytes4(ret) == ExecutorV3.Rejected.selector) {
            (uint8 reason) = abi.decode(_slice(ret), (uint8));
            assertTrue(
                reason == uint8(ReasonV3.VAULT_IN_HANDOVER) || reason == uint8(ReasonV3.EPOCH_MISMATCH)
                    || reason == uint8(ReasonV3.SESSION_UNKNOWN) || reason == uint8(ReasonV3.PAUSED)
                    || reason == uint8(ReasonV3.INSUFFICIENT_BALANCE) || reason == uint8(ReasonV3.ORACLE_STALE),
                "a handover refusal with another reason"
            );
        }
        for (uint256 k = 0; k < a.length; ++k) {
            if (sv.sharesOf(a[k]) != 0) assertEq(sv.freeShares(a[k]), sv.sharesOf(a[k]), "a lock held in handover");
        }
    }

    function _slice(bytes memory ret) internal pure returns (bytes memory out) {
        out = new bytes(ret.length - 4);
        for (uint256 i = 0; i < out.length; ++i) {
            out[i] = ret[i + 4];
        }
    }

    function invariant_TheWindowNeverExceedsTwenty() public view {
        (, uint256 left,,) = executor.limits(address(sv));
        assertLe(left, 20);
    }

    function afterInvariant() public view {
        assertGt(handler.calls(), 0);
    }
}

/// Probe (L-40): one scripted run reaches trades, deposits, both exits, a sale and an acceptance.
contract StrategyVaultV3ExecutorProbe is StrategyVaultV3ExecutorInvariantTest {
    function test_TheHandlerReachesEveryState() public {
        VaultExecutorHandler h = handler;
        h.deposit(1, 300e6);
        h.deposit(2, 200e6);
        h.deposit(3, 100e6);
        for (uint256 i = 0; i < 120; i++) {
            uint256 r = uint256(keccak256(abi.encode(i)));
            uint256 w = i % 8;
            if (w == 0 || w == 1) h.trade(r, uint8(r >> 8), r >> 16, 1, 1, 1);
            else if (w == 2) h.wait(2 hours);
            else if (w == 3) h.deposit(1 + (r % 3), r >> 8);
            else if (w == 4) h.oracleMove(uint8(r), 9_900 + (r % 200));
            else if (w == 5) h.pokeReference();
            else if (w == 6) h.emergency(3);
            else h.intrude(r, r >> 8, r >> 16);
        }
        assertGt(h.trades(), 10, "trades");
        assertGt(h.deposits(), 3, "deposits");
        assertGt(sv.heldCount(), 3, "several tokens held");
        // A day with no deposits: the locks end and both exits go through.
        for (uint256 i = 0; i < 13; i++) {
            h.wait(2 hours);
            h.pokeReference();
        }
        h.redeem(1, 1e18);
        h.redeemInKind(2, 1e18);
        assertGt(h.exits(), 0, "usdc exits");
        assertGt(h.inKindExits(), 0, "in-kind exits");
        h.sale(0);
        h.stakeAndAccept(500e6);
        assertEq(h.sales(), 1);
        assertEq(h.acceptances(), 1);
        assertFalse(h.violated(), h.violation());
    }
}
