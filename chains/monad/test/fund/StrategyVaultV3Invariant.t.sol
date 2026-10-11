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

/// Drives the vault through random sequences by every role (P7-U1, MV-S3,
/// MV-S4 and M-13 in its P7-U1 form): the leader, three depositors, the
/// Executor trading two tokens, the tighteners, a buyer who takes the agent
/// over, and a world that moves prices, donates, blacklists and waits. P7-U3
/// extends this over many real tokens on a fork.
contract VaultHandler is Test {
    struct Refs {
        StrategyVaultV3 sv;
        VaultHarnessFactory factory;
        MockAgentNFT nft;
        MockExecutorV3 executor;
        MockFeed monUsd;
        MockFeed usdcUsd;
        MockFeed aUsd;
        MockFeed bRate;
    }

    StrategyVaultV3 internal sv;
    VaultHarnessFactory internal factory;
    MockAgentNFT internal nft;
    MockExecutorV3 internal executor;
    MockFeed[4] internal feeds;
    MockToken[3] internal toks; // USDC, A, B
    address[5] internal actors; // the first leader, three depositors, the buyer
    address internal guardian;
    address internal sentinel;
    uint256 internal agentId;

    /// Where every exit and claim pays: it never sends anything back.
    address public immutable SINK = makeAddr("exit recipient");

    /// Everything that ever entered the vault, per token: deposits, donations, trade fills.
    mapping(address => uint256) public totalIn;
    /// Everything that ever left: exits, claims, trade pulls.
    mapping(address => uint256) public totalOut;
    bool public unauthorizedSuccess;
    string public unauthorizedWhat;
    uint256 public calls;
    uint256 public deposits;
    uint256 public usdcExits;
    uint256 public inKindExits;
    uint256 public credits;
    uint256 public trades;
    uint256 public sales;
    uint256 public acceptances;
    uint256 public closes;

    constructor(
        Refs memory r,
        MockToken[3] memory toks_,
        address[5] memory actors_,
        address[2] memory keys,
        uint256 id
    ) {
        sv = r.sv;
        factory = r.factory;
        nft = r.nft;
        executor = r.executor;
        feeds = [r.monUsd, r.usdcUsd, r.aUsd, r.bRate];
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

    function tokens() external view returns (MockToken[3] memory) {
        return toks;
    }

    function token(uint256 seed) internal view returns (MockToken) {
        return toks[seed % 3];
    }

    function depositor(uint256 seed) internal view returns (address) {
        return actors[1 + seed % 3];
    }

    function manager() internal view returns (address) {
        return sv.manager();
    }

    // ----- the leader and the depositors -----

    function leaderDeposit(uint256 amount) external {
        calls++;
        address m = manager();
        if (m == address(0)) return;
        amount = bound(amount, 1, 1_000e6);
        vm.prank(m);
        try sv.deposit(amount, 0) {
            totalIn[address(toks[0])] += amount;
            deposits++;
        } catch {}
    }

    function setDepositsOpen(bool open) external {
        calls++;
        address m = manager();
        if (m == address(0)) return;
        vm.prank(m);
        try sv.setDepositsOpen(open) {} catch {}
    }

    function deposit(uint256 seed, uint256 amount) external {
        calls++;
        address who = depositor(seed);
        amount = bound(amount, 1, 500e6);
        vm.prank(who);
        try sv.deposit(amount, 0) {
            totalIn[address(toks[0])] += amount;
            deposits++;
        } catch {}
    }

    function redeem(uint256 seed, uint256 part) external {
        calls++;
        address who = actors[seed % 5];
        uint256 held = sv.sharesOf(who);
        if (held == 0) return;
        uint256 shares = bound(part, 1, held);
        vm.prank(who);
        try sv.redeem(shares, SINK, 0, uint64(block.timestamp + 60)) returns (uint256 assets) {
            totalOut[address(toks[0])] += assets;
            usdcExits++;
        } catch {}
    }

    function redeemInKind(uint256 seed, uint256 part) external {
        calls++;
        address who = actors[seed % 5];
        uint256 held = sv.sharesOf(who);
        if (held == 0) return;
        uint256 shares = bound(part, 1, held);
        uint256[3] memory before = balances();
        vm.prank(who);
        try sv.redeemInKind(shares, SINK) {
            uint256[3] memory after_ = balances();
            for (uint256 i = 0; i < 3; ++i) {
                totalOut[address(toks[i])] += before[i] - after_[i];
                if (sv.claimable(address(toks[i]), who) > 0) credits++;
            }
            inKindExits++;
        } catch {}
    }

    function claim(uint256 seed, uint256 tokenSeed) external {
        calls++;
        address who = actors[seed % 5];
        MockToken t = token(tokenSeed);
        uint256 before = t.balanceOf(address(sv));
        vm.prank(who);
        try sv.claim(address(t), SINK) {
            totalOut[address(t)] += before - t.balanceOf(address(sv));
        } catch {}
    }

    // ----- the Executor: honest trades inside the core's trade cap -----

    function trade(uint256 seed, uint256 part) external {
        calls++;
        if (factory.executor() != address(executor)) return;
        MockToken t = seed % 2 == 0 ? toks[1] : toks[2];
        bool buy = (seed >> 8) % 2 == 0;
        address tokenIn = buy ? address(toks[0]) : address(t);
        address tokenOut = buy ? address(t) : address(toks[0]);
        uint256 held = MockToken(tokenIn).balanceOf(address(sv));
        if (held == 0) return;
        uint256 amountIn = bound(part, 1, held / 12 + 1);
        if (amountIn > held) amountIn = held;
        SwapParamsV3 memory p = SwapParamsV3({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: 1,
            routeHash: bytes32(0),
            deadline: uint64(block.timestamp + 60),
            ownershipEpoch: nft.ownerEpoch(agentId),
            configEpoch: 0,
            attestationIn: "",
            attestationOut: ""
        });
        uint256[3] memory before = balances();
        try executor.swap(sv, p) {
            uint256[3] memory after_ = balances();
            for (uint256 i = 0; i < 3; ++i) {
                if (after_[i] > before[i]) totalIn[address(toks[i])] += after_[i] - before[i];
                else totalOut[address(toks[i])] += before[i] - after_[i];
            }
            trades++;
        } catch {}
    }

    // ----- the world -----

    function movePrice(uint256 answer) external {
        calls++;
        answer = bound(answer, 3e8, 12e8);
        feeds[2].push(int256(answer));
        executor.setPrice(address(toks[1]), answer * 1e10);
    }

    function warp(uint256 seconds_) external {
        calls++;
        vm.warp(block.timestamp + bound(seconds_, 1, 8 days));
        for (uint256 i = 0; i < 4; ++i) {
            feeds[i].push(feeds[i].answer());
        }
    }

    function donate(uint256 seed, uint256 amount) external {
        calls++;
        MockToken t = token(seed);
        amount = bound(amount, 1, seed % 3 == 0 ? 50e6 : seed % 3 == 1 ? 10e18 : 1e8);
        t.mint(address(sv), amount);
        totalIn[address(t)] += amount;
    }

    /// A token's blacklist on the vault, on the recipient, or neither.
    function setBlock(uint256 seed) external {
        calls++;
        MockToken t = token(seed);
        t.setBlocked(address(sv), (seed >> 8) % 3 == 1);
        t.setBlocked(SINK, (seed >> 8) % 3 == 2);
    }

    function poke(bool theReference) external {
        calls++;
        if (theReference) {
            try sv.pokeReference() {} catch {}
        } else {
            try sv.poke() {} catch {}
        }
    }

    // ----- the tighteners, and the manager's own switches -----

    function tighten(uint256 actorSeed, uint256 which) external {
        calls++;
        address actor = [manager(), guardian, sentinel][actorSeed % 3];
        if (actor == address(0)) return;
        vm.startPrank(actor);
        if (which % 3 == 0) sv.setReduceOnly();
        else if (which % 3 == 1) sv.pause();
        else sv.closeDeposits();
        vm.stopPrank();
    }

    function managerLoosen(uint256 which) external {
        calls++;
        address m = manager();
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
        address m = manager();
        if (m == address(0)) return;
        duration = bound(duration, 1 days, 7 days);
        vm.prank(m);
        try sv.setLockup(uint64(duration)) {} catch {}
    }

    function managerProposeFee(uint256 bps) external {
        calls++;
        address m = manager();
        if (m == address(0)) return;
        vm.prank(m);
        try sv.proposeFee(uint16(bound(bps, 0, 2_000))) {} catch {}
    }

    function applyPending() external {
        calls++;
        try sv.applyLockup() {} catch {}
        try sv.applyFee() {} catch {}
    }

    /// Rare: the manager winds the vault down for the rest of the run.
    function closeVault(uint256 seed) external {
        calls++;
        if (seed % 40 != 0) return;
        address m = manager();
        if (m == address(0)) return;
        vm.prank(m);
        try sv.closeVault() {
            closes++;
        } catch {}
    }

    // ----- a sale, and the buyer taking over -----

    function sale(uint256 seed) external {
        calls++;
        if (seed % 12 != 0) return;
        address current = nft.ownerOf(agentId);
        address next = current == actors[4] ? actors[0] : actors[4];
        nft.setOwner(agentId, next);
        sales++;
    }

    function stakeAndAccept(uint256 amount) external {
        calls++;
        if (!sv.inHandover()) return;
        address agentOwner = nft.ownerOf(agentId);
        amount = bound(amount, 1e6, 2_000e6);
        vm.prank(agentOwner);
        try sv.stakeAsIncomingLeader(amount, 0) {
            totalIn[address(toks[0])] += amount;
            deposits++;
        } catch {}
        vm.warp(block.timestamp + 3 days);
        for (uint256 i = 0; i < 4; ++i) {
            feeds[i].push(feeds[i].answer());
        }
        vm.prank(agentOwner);
        try sv.acceptManagement() {
            acceptances++;
        } catch {}
    }

    // ----- everyone else, trying every path that is not their own exit -----

    function intrude(uint256 actorSeed, uint256 which, uint256 amount) external {
        calls++;
        address m = manager();
        address[7] memory candidates =
            [makeAddr("stranger"), guardian, sentinel, address(factory), actors[1], actors[2], actors[4]];
        address actor = candidates[actorSeed % 7];
        if (actor == m) return;
        MockToken t = token(amount);
        amount = bound(amount, 1, 100e18);
        SwapParamsV3 memory p = SwapParamsV3({
            tokenIn: address(t),
            tokenOut: address(t) == address(toks[0]) ? address(toks[1]) : address(toks[0]),
            amountIn: amount,
            minAmountOut: 1,
            routeHash: bytes32(0),
            deadline: uint64(block.timestamp + 60),
            ownershipEpoch: nft.ownerEpoch(agentId),
            configEpoch: 0,
            attestationIn: "",
            attestationOut: ""
        });
        bytes memory data;
        uint256 w = which % 12;
        if (w == 0) data = abi.encodeCall(CustodyCoreV3.withdraw, (address(t), amount, actor));
        else if (w == 1) data = abi.encodeCall(CustodyCoreV3.withdrawAll, (actor));
        else if (w == 2) data = abi.encodeCall(CustodyCoreV3.pullForSwap, (address(t), amount));
        else if (w == 3) data = abi.encodeCall(CustodyCoreV3.executeSwap, (p));
        else if (w == 4) data = abi.encodeCall(StrategyVaultV3.initialize, (agentId, actor));
        else if (w == 5) data = abi.encodeCall(StrategyVaultV3.transfer, (actor, amount));
        else if (w == 6) data = abi.encodeCall(StrategyVaultV3.setDepositsOpen, (true));
        else if (w == 7) data = abi.encodeCall(StrategyVaultV3.setLockup, (uint64(1 days)));
        else if (w == 8) data = abi.encodeCall(StrategyVaultV3.closeVault, ());
        else if (w == 9) data = abi.encodeCall(StrategyVaultV3.proposeFee, (uint16(100)));
        else if (w == 10) data = abi.encodeCall(CustodyCoreV3.unpause, ());
        else data = abi.encodeCall(CustodyCoreV3.openDeposits, ());
        // The tighteners may close and pause, which is theirs; the probes here are the loosening and moving calls.
        vm.prank(actor);
        (bool ok,) = address(sv).call(data);
        if (ok) {
            unauthorizedSuccess = true;
            unauthorizedWhat = string.concat("call ", vm.toString(w), " by ", vm.toString(actor));
        }
    }

    function balances() internal view returns (uint256[3] memory b) {
        for (uint256 i = 0; i < 3; ++i) {
            b[i] = toks[i].balanceOf(address(sv));
        }
    }
}

contract StrategyVaultV3InvariantTest is StrategyVaultV3Base {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        setVaultExecutor();
        handler = new VaultHandler(
            VaultHandler.Refs(sv, vaultFactory, nft, executor, monUsd, usdcUsd, aUsd, bRate),
            [usdc, tokA, tokB],
            [owner, alice, bob, makeAddr("carol"), buyer],
            [guardian, sentinel],
            AGENT
        );
        targetContract(address(handler));
    }

    /// MV-S3: the supply is exactly the shares held: the leader's stake, the
    /// incoming stake and every ordinary balance.
    function invariant_TheSupplyIsTheSumOfShares() public view {
        address[5] memory a = handler.actorList();
        uint256 sum = sv.leaderShares() + sv.incomingShares();
        for (uint256 i = 0; i < a.length; ++i) {
            sum += sv.balanceOf(a[i]);
        }
        assertEq(sv.totalSupply(), sum);
    }

    /// Conservation: what entered is in the vault or left through an exit, a
    /// claim or the Executor's trade; nothing else ever moves a token.
    function invariant_FundsLeaveOnlyThroughExitsClaimsAndTrades() public view {
        MockToken[3] memory t = handler.tokens();
        for (uint256 i = 0; i < 3; ++i) {
            assertEq(
                t[i].balanceOf(address(sv)) + handler.totalOut(address(t[i])),
                handler.totalIn(address(t[i])),
                t[i].name()
            );
        }
    }

    function invariant_NoOneElseMovesFundsOrLoosensAnything() public view {
        assertFalse(handler.unauthorizedSuccess(), handler.unauthorizedWhat());
    }

    /// The leader holds 5% or more whenever the rule applies: outside a
    /// handover and before the wind-down's longest lockup has passed.
    function invariant_TheLeaderStakeHolds() public view {
        if (sv.totalSupply() == 0 || sv.inHandover()) return;
        uint64 windDownAt = sv.windDownAt();
        if (windDownAt != 0 && block.timestamp >= windDownAt + 7 days) return;
        assertGe(sv.leaderShares() * 10_000, 500 * sv.totalSupply(), "the leader fell below 5%");
    }

    /// M-13 in its P7-U1 form: every holder with free shares can leave in kind
    /// now, for the floor of their slice of every token (or a credit for a
    /// token that refuses to move); a holder still locked unlocks within the
    /// hard maximum.
    function invariant_EveryHolderCanAlwaysRedeemInKind() public {
        address[5] memory a = handler.actorList();
        for (uint256 i = 0; i < a.length; ++i) {
            uint256 held = sv.sharesOf(a[i]);
            if (held == 0) continue;
            uint256 free = sv.freeShares(a[i]);
            if (free == 0) {
                (, uint64 unlockAt) = sv.lockOf(a[i]);
                assertGt(unlockAt, block.timestamp, "locked with no unlock ahead");
                assertLe(unlockAt, block.timestamp + 7 days, "a lock beyond the hard maximum");
                continue;
            }
            // The leader's exit may be held by the 5% rule; a depositor's never is.
            if (a[i] == sv.leader() && !sv.inHandover()) continue;
            uint256 snap = vm.snapshotState();
            _exitInKind(a[i], held, free);
            vm.revertToState(snap);
        }
    }

    /// `who` leaves with `free` shares now, for the floor of each slice or a credit.
    function _exitInKind(address who, uint256 held, uint256 free) internal {
        MockToken[3] memory t = handler.tokens();
        address sink = handler.SINK();
        uint256 supply = sv.totalSupply();
        uint256[3] memory before;
        uint256[3] memory sinkBefore;
        for (uint256 k = 0; k < 3; ++k) {
            before[k] = sv.freeBalance(address(t[k]));
            sinkBefore[k] = t[k].balanceOf(sink);
        }
        (address[] memory heldTokens, uint256[] memory preview) = sv.inKindAmounts(free);
        vm.prank(who);
        sv.redeemInKind(free, sink);
        for (uint256 k = 0; k < 3; ++k) {
            uint256 paid = t[k].balanceOf(sink) - sinkBefore[k];
            // A token donated but never held is not part of the vault's value or payout (D-056).
            if (!_listed(heldTokens, address(t[k]))) {
                assertEq(paid, 0, "an unheld token was paid");
                continue;
            }
            _assertSlice(t[k], who, before[k] * free / supply, paid);
            assertEq(preview[_indexIn(heldTokens, address(t[k]))], before[k] * free / supply, "the preview");
        }
        assertEq(sv.sharesOf(who), held - free);
    }

    function _listed(address[] memory list, address token) internal pure returns (bool) {
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i] == token) return true;
        }
        return false;
    }

    function _indexIn(address[] memory list, address token) internal pure returns (uint256) {
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i] == token) return i;
        }
        revert("not listed");
    }

    function _assertSlice(MockToken t, address who, uint256 slice, uint256 paid) internal view {
        uint256 credited = sv.claimable(address(t), who);
        assertTrue(paid == slice || (paid == 0 && credited >= slice), "the slice was neither paid nor credited");
    }

    function invariant_FreeSharesNeverExceedShares() public view {
        address[5] memory a = handler.actorList();
        for (uint256 i = 0; i < a.length; ++i) {
            assertLe(sv.freeShares(a[i]), sv.sharesOf(a[i]));
        }
    }

    function invariant_CreditsAreConsistent() public view {
        address[5] memory a = handler.actorList();
        MockToken[3] memory t = handler.tokens();
        for (uint256 k = 0; k < 3; ++k) {
            uint256 sum;
            for (uint256 i = 0; i < a.length; ++i) {
                sum += sv.claimable(address(t[k]), a[i]);
            }
            assertEq(sv.totalClaimable(address(t[k])), sum);
            assertLe(sum, t[k].balanceOf(address(sv)));
        }
    }

    function invariant_TheHeldListIsConsistent() public view {
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

    /// The core's modes only ever hold NORMAL, REDUCE_ONLY, PAUSED or WIND_DOWN; a wind-down never returns to NORMAL.
    function invariant_AWindDownNeverReturnsToNormal() public view {
        if (sv.windDownAt() != 0) {
            assertTrue(sv.mode() == AccountMode.WIND_DOWN || sv.mode() == AccountMode.PAUSED);
        }
    }

    function afterInvariant() public view {
        assertGt(handler.calls(), 0);
    }
}

/// Probe (L-40): one scripted sequence reaches deposits, both exits, credits,
/// trades, a sale and an acceptance, so the invariant runs are known to cover them.
contract StrategyVaultV3HandlerProbe is StrategyVaultV3Base {
    function test_TheHandlerReachesEveryState() public {
        setVaultExecutor();
        VaultHandler h = new VaultHandler(
            VaultHandler.Refs(sv, vaultFactory, nft, executor, monUsd, usdcUsd, aUsd, bRate),
            [usdc, tokA, tokB],
            [owner, alice, bob, makeAddr("carol"), buyer],
            [guardian, sentinel],
            AGENT
        );
        h.leaderDeposit(500e6);
        h.setDepositsOpen(true);
        for (uint256 i = 0; i < 90; i++) {
            uint256 r = uint256(keccak256(abi.encode(i)));
            uint256 w = i % 9;
            if (w == 0) h.deposit(r, r >> 8);
            else if (w == 1) h.trade(r, r >> 8);
            else if (w == 2) h.warp(2 days);
            else if (w == 3) h.redeem(r, r >> 8);
            else if (w == 4) h.redeemInKind(r, r >> 8);
            else if (w == 5) h.movePrice(r);
            else if (w == 6) h.intrude(r, r >> 8, r >> 16);
            else if (w == 7) h.setBlock(r);
            else h.claim(r, r >> 8);
        }
        h.setBlock(256 + 1);
        h.warp(8 days);
        h.redeemInKind(1, 1e18);
        h.sale(0);
        h.stakeAndAccept(400e6);
        assertGt(h.deposits(), 0, "deposits");
        assertGt(h.usdcExits(), 0, "usdc exits");
        assertGt(h.inKindExits(), 0, "in-kind exits");
        assertGt(h.trades(), 0, "trades");
        assertGt(h.credits(), 0, "credits");
        assertEq(h.sales(), 1, "sales");
        assertEq(h.acceptances(), 1, "acceptances");
        assertFalse(h.unauthorizedSuccess(), h.unauthorizedWhat());
    }
}

/// Anyone holding no shares, with any calldata at all, moves nothing.
contract StrategyVaultV3FuzzTest is StrategyVaultV3Base {
    function testFuzz_AnyCallByAnyoneWithoutSharesMovesNothing(address caller, bytes calldata data) public {
        threeDepositors();
        vaultBuys(address(tokA), 60e6);
        vm.assume(sv.sharesOf(caller) == 0 && caller != address(executor));
        uint256 u = usdcBal(address(sv));
        uint256 a = tokA.balanceOf(address(sv));
        uint256 supply = sv.totalSupply();
        vm.prank(caller);
        (bool ok,) = address(sv).call(data);
        ok;
        assertEq(usdcBal(address(sv)), u);
        assertEq(tokA.balanceOf(address(sv)), a);
        assertEq(sv.totalSupply(), supply);
    }
}
