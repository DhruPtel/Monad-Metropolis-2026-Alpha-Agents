// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {StrategyVaultV3} from "../../src/fund/StrategyVaultV3.sol";
import {AccountMode} from "../../src/interfaces/ICustody.sol";
import {SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
import {MockAgentNFT, MockToken} from "../mocks/CustodyMocks.sol";
import {MockExecutorV3} from "../mocks/CustodyV3Mocks.sol";
import {MockFeed} from "../mocks/OracleMocks.sol";
import {VaultHarnessFactory} from "../mocks/VaultMocks.sol";
import {StrategyVaultV3Base} from "./StrategyVaultV3Base.sol";

/// P7-U3: the vault over many held tokens. Fifteen core-lane class F tokens
/// (USDC, A, B and twelve more, each with its own feed) traded by the mock
/// Executor, with three depositors, the leader, the tighteners, a buyer, a
/// world that moves prices, blacklists tokens and waits, and strangers trying
/// every path. The invariants: everyone can always leave in kind with
/// everything else reverting (M-13), the supply is the shares, nothing moves
/// a token but a flow, a trade or a claim, no flow moves value between
/// depositors, the leader's stake holds, locks end within seven days, and
/// the held list stays inside its bound.
contract ManyTokenVaultHandler is Test {
    StrategyVaultV3 internal sv;
    VaultHarnessFactory internal factory;
    MockAgentNFT internal nft;
    MockExecutorV3 internal executor;
    MockFeed[] internal feeds;
    int256[] internal answers;
    MockToken[] internal toks;
    address[5] internal actors; // the first leader, three depositors, the buyer
    address internal guardian;
    address internal sentinel;
    uint256 internal agentId;

    address public immutable SINK = makeAddr("exit recipient");

    mapping(address => uint256) public totalIn;
    mapping(address => uint256) public totalOut;
    /// Each actor's shares as of their own last flow (deposit, exit, stake, acceptance).
    mapping(address => uint256) public sharesAtOwnFlow;
    bool public violated;
    string public violation;
    uint256 public calls;
    uint256 public deposits;
    uint256 public exits;
    uint256 public inKindExits;
    uint256 public trades;
    uint256 public credits;
    uint256 public sales;
    uint256 public acceptances;

    constructor(
        StrategyVaultV3 sv_,
        VaultHarnessFactory factory_,
        MockAgentNFT nft_,
        MockExecutorV3 executor_,
        MockFeed[] memory feeds_,
        int256[] memory answers_,
        MockToken[] memory toks_,
        address[5] memory actors_,
        address[2] memory keys,
        uint256 id
    ) {
        sv = sv_;
        factory = factory_;
        nft = nft_;
        executor = executor_;
        feeds = feeds_;
        answers = answers_;
        toks = toks_;
        actors = actors_;
        guardian = keys[0];
        sentinel = keys[1];
        agentId = id;
        for (uint256 i = 0; i < actors.length; ++i) {
            toks[0].mint(actors[i], 1e12);
            vm.prank(actors[i]);
            toks[0].approve(address(sv), type(uint256).max);
        }
    }

    function actorList() external view returns (address[5] memory) {
        return actors;
    }

    function tokenCount() external view returns (uint256) {
        return toks.length;
    }

    function tokenAt(uint256 i) external view returns (MockToken) {
        return toks[i];
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

    function _balances() internal view returns (uint256[] memory b) {
        b = new uint256[](toks.length);
        for (uint256 i = 0; i < b.length; ++i) {
            b[i] = toks[i].balanceOf(address(sv));
        }
    }

    /// The share price at the cached prices, after a fresh poke, or zero when a feed is unusable.
    function _pokedPrice() internal returns (uint256 price, bool ok) {
        try sv.poke() {
            return (sv.sharePriceE18(), true);
        } catch {
            return (0, false);
        }
    }

    /// A flow by `who` must never lower the price per share (no value moves to or
    /// from the others), within one unit of each held token's valuation rounding.
    function _checkFlow(address who, uint256 before, bool priced) internal {
        if (!priced) return;
        uint256 supply = sv.totalSupply();
        if (supply != 0) {
            uint256 tolerance = (sv.heldCount() + 1) * 1e30 / supply + 1;
            if (sv.sharePriceE18() + tolerance < before) _fail("a flow lowered the price per share");
        }
        sharesAtOwnFlow[who] = sv.sharesOf(who);
    }

    // ----- flows -----

    function deposit(uint256 seed, uint256 amount) external {
        calls++;
        address who = seed % 4 == 0 ? _manager() : actors[1 + seed % 3];
        if (who == address(0)) return;
        amount = bound(amount, 1, 400e6);
        (uint256 before, bool priced) = _pokedPrice();
        vm.prank(who);
        try sv.deposit(amount, 0) {
            totalIn[address(toks[0])] += amount;
            deposits++;
            _checkFlow(who, before, priced);
        } catch {}
    }

    function setDepositsOpen(bool open) external {
        calls++;
        address m = _manager();
        if (m == address(0)) return;
        vm.prank(m);
        try sv.setDepositsOpen(open) {} catch {}
    }

    function redeem(uint256 seed, uint256 part) external {
        calls++;
        address who = actors[seed % 5];
        uint256 held = sv.sharesOf(who);
        if (held == 0) return;
        uint256 shares = bound(part, 1, held);
        (uint256 before, bool priced) = _pokedPrice();
        uint256 supply = sv.totalSupply();
        uint256 nav = priced ? sv.navUsdc() : 0;
        vm.prank(who);
        try sv.redeem(shares, SINK, 0, uint64(block.timestamp + 60)) returns (uint256 assets) {
            totalOut[address(toks[0])] += assets;
            exits++;
            // Never more than the shares' part of the value at the prices used.
            if (priced && assets > nav * shares / supply) _fail("a USDC exit paid above the shares' value");
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
        uint256[] memory bal = _balances();
        (address[] memory heldTokens, uint256[] memory preview) = sv.inKindAmounts(shares);
        vm.prank(who);
        try sv.redeemInKind(shares, SINK) {
            uint256[] memory after_ = _balances();
            for (uint256 i = 0; i < toks.length; ++i) {
                uint256 paid = bal[i] - after_[i];
                uint256 idx = _indexIn(heldTokens, address(toks[i]));
                // Paid the previewed floor, or nothing (kept as the exiter's credit); never more.
                if (idx == type(uint256).max ? paid != 0 : paid != preview[idx] && paid != 0) {
                    _fail("an in-kind exit paid something other than the slice");
                }
                totalOut[address(toks[i])] += paid;
                if (sv.claimable(address(toks[i]), who) > 0) credits++;
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

    function pokeReference() external {
        calls++;
        try sv.pokeReference() {} catch {}
    }

    function claim(uint256 seed, uint256 tokenSeed) external {
        calls++;
        address who = actors[seed % 5];
        MockToken t = toks[tokenSeed % toks.length];
        uint256 before = t.balanceOf(address(sv));
        vm.prank(who);
        try sv.claim(address(t), SINK) {
            totalOut[address(t)] += before - t.balanceOf(address(sv));
        } catch {}
    }

    // ----- the mock Executor trades any pair, mostly fairly -----

    function trade(uint256 seed, uint256 part, uint256 fill) external {
        calls++;
        if (factory.executor() != address(executor)) return;
        MockToken tin = toks[seed % toks.length];
        MockToken tout = toks[(seed >> 8) % toks.length];
        if (address(tin) == address(tout)) tout = toks[(seed % (toks.length - 1)) + 1];
        uint256 held = tin.balanceOf(address(sv));
        if (held == 0) return;
        uint256 amountIn = bound(part, 1, held / 12 + 1);
        if (amountIn > held) amountIn = held;
        // A fill a hair under fair most of the time, sometimes over the 1% backstop (refused).
        executor.setOutputBps(bound(fill, 9_880, 10_050));
        uint256 navBefore;
        try sv.navUsdc() returns (uint256 n) {
            navBefore = n;
        } catch {
            return;
        }
        SwapParamsV3 memory p = SwapParamsV3({
            tokenIn: address(tin),
            tokenOut: address(tout),
            amountIn: amountIn,
            minAmountOut: 1,
            routeHash: bytes32(0),
            deadline: uint64(block.timestamp + 60),
            ownershipEpoch: nft.ownerEpoch(agentId),
            configEpoch: 0,
            attestationIn: "",
            attestationOut: ""
        });
        uint256[] memory before = _balances();
        uint256 supply = sv.totalSupply();
        try executor.swap(sv, p) {
            uint256[] memory after_ = _balances();
            for (uint256 i = 0; i < toks.length; ++i) {
                if (after_[i] > before[i]) totalIn[address(toks[i])] += after_[i] - before[i];
                else totalOut[address(toks[i])] += before[i] - after_[i];
            }
            trades++;
            if (sv.totalSupply() != supply) _fail("a trade touched the shares");
            // The core's 1% backstop: the vault lost at most 1% of the value it sent.
            uint256 navAfter = sv.navUsdc();
            uint256 valueIn = navBefore - _navWithout(address(tin), before, amountIn);
            if (navAfter + valueIn / 100 + 1 < navBefore) _fail("a trade lost more than the slippage backstop");
        } catch {}
        executor.setOutputBps(10_000);
    }

    /// The vault's value with `amountIn` of `token` taken out, at the cached prices: what a trade sent.
    function _navWithout(address token, uint256[] memory balances, uint256 amountIn) internal view returns (uint256) {
        uint256 nav;
        for (uint256 i = 0; i < toks.length; ++i) {
            uint256 b = address(toks[i]) == token ? balances[i] - amountIn : balances[i];
            (uint256 px,) = sv.lastPrice(address(toks[i]));
            uint8 dec = toks[i].decimals();
            nav += (b - _min(b, sv.totalClaimable(address(toks[i])))) * px / (10 ** (uint256(dec) + 12));
        }
        return nav;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // ----- the world -----

    /// Moves one feed: MON/USD (which prices B through its rate), A's, B's rate,
    /// or an extra token's; USDC/USD stays at 1. The mock Executor quotes at the feeds.
    function movePrice(uint256 which, uint256 bps) external {
        calls++;
        uint256 i = 1 + which % (feeds.length - 1);
        int256 next = answers[i] * int256(bound(bps, 8_000, 12_500)) / 10_000;
        if (next < 1e6) next = 1e6;
        answers[i] = next;
        feeds[i].push(next);
        if (i == 1 || i == 3) {
            // B is 1e18 of rate (B per MON, 18 decimals) times MON/USD (8 decimals).
            executor.setPrice(address(toks[2]), uint256(answers[3]) * uint256(answers[1]) * 1e10 / 1e18);
        } else if (i == 2) {
            executor.setPrice(address(toks[1]), uint256(next) * 1e10);
        } else {
            executor.setPrice(address(toks[i - 1]), uint256(next) * 1e10);
        }
    }

    function wait(uint256 seconds_) external {
        calls++;
        vm.warp(block.timestamp + bound(seconds_, 1, 3 days));
        for (uint256 i = 0; i < feeds.length; ++i) {
            feeds[i].push(answers[i]);
        }
    }

    /// A token refuses to move for the vault, or moves again.
    function setBlock(uint256 seed) external {
        calls++;
        MockToken t = toks[seed % toks.length];
        t.setBlocked(address(sv), (seed >> 8) % 3 == 1);
    }

    function donate(uint256 seed, uint256 amount) external {
        calls++;
        MockToken t = toks[seed % toks.length];
        amount = bound(amount, 1, seed % toks.length == 0 ? 50_000e6 : 50_000e18);
        t.mint(address(sv), amount);
        totalIn[address(t)] += amount;
    }

    // ----- roles -----

    function tighten(uint256 actorSeed, uint256 which) external {
        calls++;
        address actor = [_manager(), guardian, sentinel][actorSeed % 3];
        if (actor == address(0)) return;
        vm.startPrank(actor);
        if (which % 3 == 0) sv.setReduceOnly();
        else if (which % 3 == 1) sv.pause();
        else sv.closeDeposits();
        vm.stopPrank();
    }

    function managerLoosen(uint256 which) external {
        calls++;
        address m = _manager();
        if (m == address(0)) return;
        vm.startPrank(m);
        if (which % 2 == 0) {
            try sv.unpause() {} catch {}
        } else {
            sv.openDeposits();
        }
        vm.stopPrank();
    }

    function managerSetLockup(uint256 duration) external {
        calls++;
        address m = _manager();
        if (m == address(0)) return;
        vm.prank(m);
        try sv.setLockup(uint64(bound(duration, 1 days, 7 days))) {} catch {}
        try sv.applyLockup() {} catch {}
    }

    function sale(uint256 seed) external {
        calls++;
        if (seed % 10 != 0) return;
        address current = nft.ownerOf(agentId);
        nft.setOwner(agentId, current == actors[4] ? actors[0] : actors[4]);
        sales++;
    }

    function stakeAndAccept(uint256 amount) external {
        calls++;
        if (!sv.inHandover()) return;
        address agentOwner = nft.ownerOf(agentId);
        amount = bound(amount, 1e6, 3_000e6);
        vm.prank(agentOwner);
        try sv.stakeAsIncomingLeader(amount, 0) {
            totalIn[address(toks[0])] += amount;
            deposits++;
            sharesAtOwnFlow[agentOwner] = sv.sharesOf(agentOwner);
        } catch {}
        vm.warp(block.timestamp + 3 days);
        for (uint256 i = 0; i < feeds.length; ++i) {
            feeds[i].push(answers[i]);
        }
        address previous = sv.leader();
        vm.prank(agentOwner);
        try sv.acceptManagement() {
            acceptances++;
            sharesAtOwnFlow[previous] = sv.sharesOf(previous);
            sharesAtOwnFlow[agentOwner] = sv.sharesOf(agentOwner);
        } catch {}
    }

    // ----- everyone else -----

    function intrude(uint256 actorSeed, uint256 which, uint256 amount) external {
        calls++;
        address m = _manager();
        address[6] memory candidates =
            [makeAddr("stranger"), guardian, sentinel, address(factory), actors[1], actors[4]];
        address actor = candidates[actorSeed % 6];
        if (actor == m) return;
        MockToken t = toks[amount % toks.length];
        amount = bound(amount, 1, 100e18);
        bytes memory data;
        uint256 w = which % 8;
        if (w == 0) data = abi.encodeCall(CustodyCoreV3.withdraw, (address(t), amount, actor));
        else if (w == 1) data = abi.encodeCall(CustodyCoreV3.withdrawAll, (actor));
        else if (w == 2) data = abi.encodeCall(CustodyCoreV3.pullForSwap, (address(t), amount));
        else if (w == 3) data = abi.encodeCall(StrategyVaultV3.initialize, (agentId, actor));
        else if (w == 4) data = abi.encodeCall(StrategyVaultV3.setDepositsOpen, (true));
        else if (w == 5) data = abi.encodeCall(StrategyVaultV3.closeVault, ());
        else if (w == 6) data = abi.encodeCall(CustodyCoreV3.unpause, ());
        else data = abi.encodeCall(StrategyVaultV3.transfer, (actor, amount));
        vm.prank(actor);
        (bool ok,) = address(sv).call(data);
        if (ok) _fail(string.concat("an intruder's call ", vm.toString(w), " went through"));
    }
}

contract StrategyVaultV3ManyTokensInvariantTest is StrategyVaultV3Base {
    ManyTokenVaultHandler internal handler;
    MockToken[] internal all;
    address internal carol = makeAddr("carol");

    function setUp() public override {
        super.setUp();
        MockToken[] memory extra = coreTokens(12);
        all.push(usdc);
        all.push(tokA);
        all.push(tokB);
        for (uint256 i = 0; i < extra.length; ++i) {
            all.push(extra[i]);
        }
        setVaultExecutor();
        MockFeed[] memory feeds = new MockFeed[](4 + extra.length);
        int256[] memory answers = new int256[](feeds.length);
        (feeds[0], answers[0]) = (usdcUsd, int256(1e8));
        (feeds[1], answers[1]) = (monUsd, int256(2e8));
        (feeds[2], answers[2]) = (aUsd, int256(6e8));
        (feeds[3], answers[3]) = (bRate, int256(20e18));
        for (uint256 i = 0; i < extra.length; ++i) {
            feeds[4 + i] = extraFeeds[i];
            answers[4 + i] = 1e8;
        }
        handler = new ManyTokenVaultHandler(
            sv,
            vaultFactory,
            nft,
            executor,
            feeds,
            answers,
            all,
            [owner, alice, bob, carol, buyer],
            [guardian, sentinel],
            AGENT
        );
        targetContract(address(handler));
    }

    function _assertSlice(MockToken t, address who, uint256 slice, uint256 paid) internal view {
        uint256 credited = sv.claimable(address(t), who);
        assertTrue(paid == slice || (paid == 0 && credited >= slice), "the slice was neither paid nor credited");
    }

    /// M-13 over the run: with the vault paused and the oracle, the registry, the
    /// factory, the Executor and AgentNFT all replaced by reverting code, every
    /// holder leaves in kind for the floor of each held token's slice, or a
    /// credit where the token refuses to move.
    function invariant_EveryoneLeavesInKindWithEverythingElseReverting() public {
        uint256 snap = vm.snapshotState();
        vm.prank(guardian);
        try sv.pause() {} catch {}
        bytes memory dead = hex"60006000fd";
        vm.etch(address(oracle), dead);
        vm.etch(address(tokens), dead);
        vm.etch(address(vaultFactory), dead);
        vm.etch(address(nft), dead);
        vm.etch(address(executor), dead);
        address[5] memory a = handler.actorList();
        address sink = handler.SINK();
        for (uint256 i = 0; i < a.length; ++i) {
            uint256 held = sv.sharesOf(a[i]);
            if (held == 0) continue;
            _exitEverything(a[i], held, sink);
        }
        assertEq(sv.totalSupply(), 0, "everyone left");
        vm.revertToState(snap);
    }

    function _exitEverything(address who, uint256 held, address sink) internal {
        uint256 n = handler.tokenCount();
        (address[] memory heldTokens, uint256[] memory preview) = sv.inKindAmounts(held);
        uint256[] memory sinkBefore = new uint256[](n);
        for (uint256 k = 0; k < n; ++k) {
            sinkBefore[k] = handler.tokenAt(k).balanceOf(sink);
        }
        vm.prank(who);
        sv.redeemInKind(held, sink);
        for (uint256 k = 0; k < n; ++k) {
            MockToken t = handler.tokenAt(k);
            uint256 paid = t.balanceOf(sink) - sinkBefore[k];
            uint256 idx = _indexIn(heldTokens, address(t));
            if (idx == type(uint256).max) {
                assertEq(paid, 0, "an unheld token was paid");
                continue;
            }
            _assertSlice(t, who, preview[idx], paid);
        }
        assertEq(sv.sharesOf(who), 0);
    }

    function _indexIn(address[] memory list, address token) internal pure returns (uint256) {
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i] == token) return i;
        }
        return type(uint256).max;
    }

    function invariant_TheSupplyIsTheSumOfShares() public view {
        address[5] memory a = handler.actorList();
        uint256 sum = sv.leaderShares() + sv.incomingShares();
        for (uint256 i = 0; i < a.length; ++i) {
            sum += sv.balanceOf(a[i]);
        }
        assertEq(sv.totalSupply(), sum);
    }

    /// Nothing moves a token but a flow, a claim or a trade.
    function invariant_FundsLeaveOnlyThroughExitsClaimsAndTrades() public view {
        for (uint256 k = 0; k < handler.tokenCount(); ++k) {
            MockToken t = handler.tokenAt(k);
            assertEq(t.balanceOf(address(sv)) + handler.totalOut(address(t)), handler.totalIn(address(t)), t.name());
        }
    }

    /// A holder's shares change only through their own flows: no call of anyone
    /// else's moves value between depositors, and no flow lowers the price per share.
    function invariant_NoValueMovesBetweenDepositors() public view {
        address[5] memory a = handler.actorList();
        for (uint256 i = 0; i < a.length; ++i) {
            assertEq(sv.sharesOf(a[i]), handler.sharesAtOwnFlow(a[i]), "shares moved without an own flow");
        }
        assertFalse(handler.violated(), handler.violation());
    }

    function invariant_TheLeaderStakeHolds() public view {
        if (sv.totalSupply() == 0 || sv.inHandover()) return;
        uint64 windDownAt = sv.windDownAt();
        if (windDownAt != 0 && block.timestamp >= windDownAt + 7 days) return;
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

    function invariant_CreditsAndTheHeldListAreConsistent() public view {
        address[5] memory a = handler.actorList();
        for (uint256 k = 0; k < handler.tokenCount(); ++k) {
            MockToken t = handler.tokenAt(k);
            uint256 sum;
            for (uint256 i = 0; i < a.length; ++i) {
                sum += sv.claimable(address(t), a[i]);
            }
            assertEq(sv.totalClaimable(address(t)), sum);
            assertLe(sum, t.balanceOf(address(sv)));
        }
        address[] memory held = sv.heldTokens();
        assertLe(held.length, 16);
        assertEq(held[0], address(usdc));
        for (uint256 i = 1; i < held.length; ++i) {
            assertGt(MockToken(held[i]).balanceOf(address(sv)), 0, "a listed token with nothing in it");
        }
    }

    function invariant_ThePlatformTotalIsThePrincipal() public view {
        assertEq(vaultFactory.platformTotal(), sv.principal());
    }

    function afterInvariant() public view {
        assertGt(handler.calls(), 0);
    }
}

/// Probe (L-40): one scripted run over the fifteen tokens reaches deposits,
/// both exits, trades across many tokens, credits, a sale and an acceptance.
contract StrategyVaultV3ManyTokensProbe is StrategyVaultV3Base {
    function test_TheHandlerReachesEveryStateOverManyTokens() public {
        MockToken[] memory extra = coreTokens(12);
        MockToken[] memory all = new MockToken[](15);
        (all[0], all[1], all[2]) = (usdc, tokA, tokB);
        for (uint256 i = 0; i < 12; ++i) {
            all[3 + i] = extra[i];
        }
        setVaultExecutor();
        MockFeed[] memory feeds = new MockFeed[](16);
        int256[] memory answers = new int256[](16);
        (feeds[0], answers[0], feeds[1], answers[1]) = (usdcUsd, int256(1e8), monUsd, int256(2e8));
        (feeds[2], answers[2], feeds[3], answers[3]) = (aUsd, int256(6e8), bRate, int256(20e18));
        for (uint256 i = 0; i < 12; ++i) {
            (feeds[4 + i], answers[4 + i]) = (extraFeeds[i], int256(1e8));
        }
        ManyTokenVaultHandler h = new ManyTokenVaultHandler(
            sv,
            vaultFactory,
            nft,
            executor,
            feeds,
            answers,
            all,
            [owner, alice, bob, makeAddr("carol"), buyer],
            [guardian, sentinel],
            AGENT
        );
        h.deposit(0, 1_000e6); // the leader
        h.setDepositsOpen(true);
        h.deposit(1, 300e6);
        h.deposit(2, 200e6);
        h.deposit(3, 100e6);
        for (uint256 i = 0; i < 160; i++) {
            uint256 r = uint256(keccak256(abi.encode(i)));
            uint256 w = i % 9;
            if (w == 0) h.deposit(1 + (r % 3), r >> 8);
            else if (w == 1 || w == 2) h.trade(r - (r % 15), r >> 8, 9_990 + (r % 20)); // from USDC
            else if (w == 3) h.wait(6 hours);
            else if (w == 4) h.redeem(1 + (r % 3), r >> 8);
            else if (w == 5) h.redeemInKind(1 + (r % 3), r >> 8);
            else if (w == 6) h.movePrice(r, 9_800 + (r % 400)); // mild moves, inside the band's day
            else if (w == 7) h.managerLoosen(0);
            else h.intrude(r, r >> 8, r >> 16);
        }
        assertGt(sv.heldCount(), 5, "many tokens held");
        h.setBlock(3 + 256); // one extra token refuses to move for the vault
        for (uint256 i = 0; i < 8; i++) {
            h.wait(1 days);
            h.pokeReference();
        }
        h.managerLoosen(0);
        h.redeemInKind(1, 1e18);
        h.sale(0);
        h.stakeAndAccept(500e6);
        assertGt(h.deposits(), 3, "deposits");
        assertGt(h.exits(), 0, "usdc exits");
        assertGt(h.inKindExits(), 0, "in-kind exits");
        assertGt(h.trades(), 10, "trades");
        assertGt(h.credits(), 0, "credits");
        assertEq(h.sales(), 1);
        assertEq(h.acceptances(), 1);
        assertFalse(h.violated(), h.violation());
    }
}
