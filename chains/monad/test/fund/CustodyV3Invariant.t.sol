// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {AccountFactoryV3} from "../../src/fund/AccountFactoryV3.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
import {MockAgentNFT, MockToken} from "../mocks/CustodyMocks.sol";
import {MockFeed} from "../mocks/OracleMocks.sol";
import {CustodyV3Base} from "./CustodyV3Base.sol";

/// Drives the account and the factory through random sequences of calls by
/// every role, over three tokens, with the Executor unset (M-06 on the
/// personal mode). Every token the account ever received is either still in it
/// or went to the owner's withdrawal recipient; nothing else ever succeeds in
/// moving funds.
contract CustodyV3Handler is Test {
    struct Refs {
        PersonalAccountV3 account;
        AccountFactoryV3 factory;
        MockAgentNFT nft;
        MockFeed monUsd;
        MockFeed usdcUsd;
        MockFeed aUsd;
        MockFeed bRate;
    }

    PersonalAccountV3 internal account;
    AccountFactoryV3 internal factory;
    MockAgentNFT internal nft;
    MockFeed[4] internal feeds;
    int256[4] internal answers;
    MockToken[3] internal toks;
    address internal owner;
    address internal admin;
    address internal guardian;
    address internal sentinel;
    uint256 internal agentId;

    /// Where every owner withdrawal pays: it never sends anything back out.
    address public immutable SINK = makeAddr("owner's recipient");

    /// Everything that ever entered the account, per token.
    mapping(address => uint256) public totalIn;
    /// Set if any call by anyone but the owner moved funds or traded.
    bool public unauthorizedSuccess;
    string public unauthorizedWhat;
    uint256 public calls;
    /// What succeeded, across the run: the probe that the deep states are reached (L-40).
    uint256 public deposits;
    uint256 public withdrawals;
    uint256 public credits;

    constructor(Refs memory r, MockToken[3] memory toks_, address[4] memory roles, uint256 agentId_) {
        account = r.account;
        factory = r.factory;
        nft = r.nft;
        feeds = [r.monUsd, r.usdcUsd, r.aUsd, r.bRate];
        answers = [int256(2e8), int256(1e8), int256(6e8), int256(20e18)];
        toks = toks_;
        owner = roles[0];
        admin = roles[1];
        guardian = roles[2];
        sentinel = roles[3];
        agentId = agentId_;
    }

    function token(uint256 seed) internal view returns (MockToken) {
        return toks[seed % 3];
    }

    function tokens() external view returns (MockToken[3] memory) {
        return toks;
    }

    // ----- the owner -----

    function ownerDeposit(uint256 seed, uint256 amount) external {
        calls++;
        MockToken t = token(seed);
        uint256 max = seed % 3 == 0 ? 300e6 : seed % 3 == 1 ? 50e18 : 5e8;
        amount = bound(amount, 1, max);
        t.mint(owner, amount);
        vm.startPrank(owner);
        t.approve(address(account), amount);
        try account.deposit(address(t), amount) {
            totalIn[address(t)] += amount;
            deposits++;
        } catch {}
        vm.stopPrank();
    }

    function ownerWithdraw(uint256 seed, uint256 amount) external {
        calls++;
        MockToken t = token(seed);
        uint256 bal = t.balanceOf(address(account));
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(owner);
        try account.withdraw(address(t), amount, SINK) {
            withdrawals++;
        } catch {}
    }

    function ownerWithdrawAll() external {
        calls++;
        vm.prank(owner);
        account.withdrawAll(SINK);
        withdrawals++;
        for (uint256 i = 0; i < 3; ++i) {
            if (account.claimable(address(toks[i]), owner) > 0) credits++;
        }
    }

    function ownerClaim(uint256 seed) external {
        calls++;
        vm.prank(owner);
        try account.claim(address(token(seed)), SINK) {} catch {}
    }

    function ownerUnpauseAndReopen() external {
        calls++;
        vm.startPrank(owner);
        account.unpause();
        account.openDeposits();
        vm.stopPrank();
    }

    function ownerOptIn(bool optIn) external {
        calls++;
        vm.prank(owner);
        account.setScreenedOptIn(optIn);
    }

    // ----- the world -----

    function donate(uint256 seed, uint256 amount) external {
        calls++;
        MockToken t = token(seed);
        amount = bound(amount, 1, seed % 3 == 0 ? 50e6 : seed % 3 == 1 ? 10e18 : 1e8);
        t.mint(address(account), amount);
        totalIn[address(t)] += amount;
    }

    /// A token's blacklist on the account, on the recipient, or neither.
    function setBlock(uint256 seed) external {
        calls++;
        MockToken t = token(seed);
        t.setBlocked(address(account), (seed >> 8) % 3 == 1);
        t.setBlocked(SINK, (seed >> 8) % 3 == 2);
    }

    function setFeedDown(uint256 seed, bool down) external {
        calls++;
        feeds[seed % 4].setFailure(down ? MockFeed.Failure.RevertRound : MockFeed.Failure.None);
    }

    /// The agent changes hands and maybe comes back: the account stays the seller's.
    function moveAgent(bool back) external {
        calls++;
        nft.setOwner(agentId, makeAddr("buyer"));
        if (back) nft.setOwner(agentId, owner);
    }

    /// Time passes; the feeds are pushed again so priced actions can still run.
    function warp(uint256 seconds_) external {
        calls++;
        vm.warp(block.timestamp + bound(seconds_, 1, 20 days));
        for (uint256 i = 0; i < 4; ++i) {
            feeds[i].push(answers[i]);
        }
    }

    // ----- the roles that may only tighten -----

    function tighten(uint256 actorSeed, uint256 which) external {
        calls++;
        address actor = [owner, guardian, sentinel][actorSeed % 3];
        vm.startPrank(actor);
        if (which % 3 == 0) account.setReduceOnly();
        else if (which % 3 == 1) account.pause();
        else account.closeDeposits();
        vm.stopPrank();
    }

    // ----- the factory's admin and guardian, never appointing an Executor -----

    function adminAct(uint256 which, uint256 value) external {
        calls++;
        vm.startPrank(which % 2 == 0 ? admin : guardian);
        uint256 w = which % 8;
        if (w == 0) {
            try factory.setPersonalCap(bound(value, 0, factory.personalCap())) {} catch {}
        } else if (w == 1) {
            try factory.setPlatformCap(bound(value, 0, factory.platformCap())) {} catch {}
        } else if (w == 2) {
            if (value % 2 == 0) {
                try factory.removeDepositor(owner) {} catch {}
            } else {
                try factory.addDepositor(owner) {} catch {}
            }
        } else if (w == 3) {
            try factory.enableAllowlist() {} catch {}
        } else if (w == 4) {
            try factory.clearExecutor() {} catch {}
        } else if (w == 5) {
            AccountFactoryV3.Action a = AccountFactoryV3.Action(4 + value % 3);
            bytes32 v = a == AccountFactoryV3.Action.DisableAllowlist ? bytes32(0) : bytes32(bound(value, 0, 100_000e6));
            try factory.propose(a, v) {} catch {}
            vm.stopPrank();
            vm.warp(block.timestamp + 9 days);
            for (uint256 i = 0; i < 4; ++i) {
                feeds[i].push(answers[i]);
            }
            try factory.execute(a, v) {} catch {}
            return;
        } else if (w == 6) {
            try factory.propose(AccountFactoryV3.Action.SetGuardian, bytes32(uint256(uint160(guardian)))) {} catch {}
        } else {
            try factory.cancel(
                factory.changeId(AccountFactoryV3.Action.SetGuardian, bytes32(uint256(uint160(guardian))))
            ) {}
                catch {}
        }
        vm.stopPrank();
    }

    // ----- everyone else, trying every path out -----

    function intrude(uint256 actorSeed, uint256 which, uint256 amount) external {
        calls++;
        address actor =
            [makeAddr("stranger"), admin, guardian, sentinel, address(factory), makeAddr("buyer")][actorSeed % 6];
        MockToken t = token(amount);
        amount = bound(amount, 1, 100e18);
        SwapParamsV3 memory p = SwapParamsV3({
            tokenIn: address(t),
            tokenOut: t == toks[0] ? address(toks[1]) : address(toks[0]),
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
        uint256 w = which % 7;
        if (w == 0) data = abi.encodeCall(CustodyCoreV3.withdraw, (address(t), amount, actor));
        else if (w == 1) data = abi.encodeCall(CustodyCoreV3.withdrawAll, (actor));
        else if (w == 2) data = abi.encodeCall(CustodyCoreV3.claim, (address(t), actor));
        else if (w == 3) data = abi.encodeCall(CustodyCoreV3.pullForSwap, (address(t), amount));
        else if (w == 4) data = abi.encodeCall(CustodyCoreV3.executeSwap, (p));
        else if (w == 5) data = abi.encodeCall(PersonalAccountV3.initialize, (agentId, actor));
        else data = abi.encodeCall(PersonalAccountV3.setScreenedOptIn, (true));
        vm.prank(actor);
        (bool ok,) = address(account).call(data);
        if (ok) {
            unauthorizedSuccess = true;
            unauthorizedWhat = string.concat("call ", vm.toString(w), " by ", vm.toString(actor));
        }
    }
}

contract CustodyV3InvariantTest is CustodyV3Base {
    CustodyV3Handler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new CustodyV3Handler(
            CustodyV3Handler.Refs(account, factory, nft, monUsd, usdcUsd, aUsd, bRate),
            [usdc, tokA, tokB],
            [owner, admin, guardian, sentinel],
            AGENT
        );
        targetContract(address(handler));
    }

    /// Conservation: what entered is in the account or with the owner's recipient.
    function invariant_FundsLeaveOnlyThroughTheOwnersWithdrawal() public view {
        address sink = handler.SINK();
        MockToken[3] memory t = handler.tokens();
        for (uint256 i = 0; i < 3; ++i) {
            assertEq(
                t[i].balanceOf(address(account)) + t[i].balanceOf(sink), handler.totalIn(address(t[i])), t[i].name()
            );
        }
    }

    function invariant_NoOneElseEverMovesFundsOrTrades() public view {
        assertFalse(handler.unauthorizedSuccess(), handler.unauthorizedWhat());
    }

    function invariant_TheExecutorStaysUnset() public view {
        assertEq(factory.executor(), address(0));
    }

    function invariant_ACreditNeverExceedsTheBalance() public view {
        MockToken[3] memory t = handler.tokens();
        for (uint256 i = 0; i < 3; ++i) {
            assertLe(account.totalClaimable(address(t[i])), t[i].balanceOf(address(account)));
            assertEq(account.totalClaimable(address(t[i])), account.claimable(address(t[i]), owner));
        }
    }

    /// One account: the platform total is exactly its principal.
    function invariant_ThePlatformTotalIsThePrincipal() public view {
        assertEq(factory.platformTotal(), account.principal());
    }

    /// The held list: USDC first, at most 16, and every other listed token still held.
    function invariant_TheHeldListIsConsistent() public view {
        address[] memory held = account.heldTokens();
        assertLe(held.length, 16);
        assertEq(held[0], address(usdc));
        for (uint256 i = 1; i < held.length; ++i) {
            assertGt(MockToken(held[i]).balanceOf(address(account)), 0, "a listed token with nothing in it");
            assertTrue(account.isHeld(held[i]));
        }
    }

    /// Counts what the runs did, so a run that only reverted cannot pass unseen.
    function afterInvariant() public view {
        assertGt(handler.calls(), 0);
    }
}

/// Anyone but the owner, with any calldata at all, moves nothing.
contract CustodyV3FuzzTest is CustodyV3Base {
    function testFuzz_AnyCallByAnyoneButTheOwnerMovesNothing(address caller, bytes calldata data) public {
        vm.assume(caller != owner);
        deposit(usdc, 50e6);
        deposit(tokA, 10e18);
        deposit(tokB, 1e8);
        vm.prank(caller);
        (bool ok,) = address(account).call(data);
        ok;
        vm.prank(caller);
        (ok,) = address(factory).call(data);
        assertEq(usdcBal(address(account)), 50e6);
        assertEq(tokA.balanceOf(address(account)), 10e18);
        assertEq(tokB.balanceOf(address(account)), 1e8);
    }

    function testFuzz_TheOwnerWithdrawsAnyAmountOfAnyTokenUpToTheBalance(uint256 seed, uint256 amount, address to)
        public
    {
        vm.assume(to != address(0) && to != address(account));
        deposit(usdc, 80e6);
        deposit(tokA, 10e18);
        deposit(tokB, 1e8);
        MockToken t = [usdc, tokA, tokB][seed % 3];
        uint256 held = t.balanceOf(address(account));
        amount = bound(amount, 1, held);
        uint256 before = t.balanceOf(to);
        vm.prank(owner);
        account.withdraw(address(t), amount, to);
        assertEq(t.balanceOf(to) - before, amount);
        assertEq(t.balanceOf(address(account)), held - amount);
        if (t == usdc) assertEq(account.principal(), 80e6 + 60e6 + 40e6 - amount);
    }
}

/// Probe (L-40): one long sequence through the handler's own entry points
/// reaches deposits, withdrawals and credits; kept as a test so it runs every time.
contract CustodyV3HandlerProbe is CustodyV3Base {
    function test_TheHandlerReachesDepositsWithdrawalsAndCredits() public {
        CustodyV3Handler h = new CustodyV3Handler(
            CustodyV3Handler.Refs(account, factory, nft, monUsd, usdcUsd, aUsd, bRate),
            [usdc, tokA, tokB],
            [owner, admin, guardian, sentinel],
            AGENT
        );
        for (uint256 i = 0; i < 60; i++) {
            uint256 r = uint256(keccak256(abi.encode(i)));
            if (i % 6 == 0) h.ownerDeposit(r, r >> 8);
            else if (i % 6 == 1) h.ownerDeposit(r + 1, r >> 8);
            else if (i % 6 == 2) h.setBlock(r);
            else if (i % 6 == 3) h.ownerWithdrawAll();
            else if (i % 6 == 4) h.ownerWithdraw(r, r >> 8);
            else h.intrude(r, r >> 8, r >> 16);
        }
        // And one sure credit: A deposited, the account blacklisted in A, everything withdrawn.
        h.ownerDeposit(1, 10e18);
        h.setBlock(256);
        h.ownerWithdrawAll();
        assertGt(h.deposits(), 0, "deposits");
        assertGt(h.withdrawals(), 0, "withdrawals");
        assertGt(h.credits(), 0, "credits");
        assertFalse(h.unauthorizedSuccess());
    }
}
