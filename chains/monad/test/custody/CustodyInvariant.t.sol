// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {AccountFactory} from "../../src/custody/AccountFactory.sol";
import {CustodyCore} from "../../src/custody/CustodyCore.sol";
import {PersonalAccount} from "../../src/custody/PersonalAccount.sol";
import {SwapParams} from "../../src/interfaces/ICustody.sol";
import {MockAgentNFT, MockOracle, MockToken} from "../mocks/CustodyMocks.sol";
import {CustodyBase} from "./CustodyBase.sol";

/// Drives the account and the factory through random sequences of calls by
/// every role, with the Executor unset (M-06 on the personal mode). Every
/// token the account ever received is either still in it or went to the
/// owner's withdrawal recipient; nothing else ever succeeds in moving funds.
contract CustodyHandler is Test {
    PersonalAccount internal account;
    AccountFactory internal factory;
    MockToken internal usdc;
    MockToken internal wmon;
    MockAgentNFT internal nft;
    MockOracle internal oracle;
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

    constructor(
        PersonalAccount account_,
        AccountFactory factory_,
        MockToken usdc_,
        MockToken wmon_,
        MockAgentNFT nft_,
        MockOracle oracle_,
        address[4] memory roles,
        uint256 agentId_
    ) {
        account = account_;
        factory = factory_;
        usdc = usdc_;
        wmon = wmon_;
        nft = nft_;
        oracle = oracle_;
        owner = roles[0];
        admin = roles[1];
        guardian = roles[2];
        sentinel = roles[3];
        agentId = agentId_;
    }

    function token(uint256 seed) internal view returns (MockToken) {
        return seed % 2 == 0 ? usdc : wmon;
    }

    // ----- the owner -----

    function ownerDeposit(uint256 seed, uint256 amount) external {
        calls++;
        MockToken t = token(seed);
        amount = bound(amount, 1, t == usdc ? 120e6 : 240e18);
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
        if (account.claimable(address(usdc)) > 0) credits++;
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

    // ----- the world -----

    function donate(uint256 seed, uint256 amount) external {
        calls++;
        MockToken t = token(seed);
        amount = bound(amount, 1, t == usdc ? 50e6 : 100e18);
        t.mint(address(account), amount);
        totalIn[address(t)] += amount;
    }

    /// USDC's blacklist on the account, on the recipient, or neither.
    function setUsdcBlock(uint256 seed) external {
        calls++;
        usdc.setBlocked(address(account), seed % 3 == 1);
        usdc.setBlocked(SINK, seed % 3 == 2);
    }

    function setOracleStale(bool stale) external {
        calls++;
        oracle.setStale(stale);
    }

    /// The agent changes hands and maybe comes back: the account stays the seller's.
    function moveAgent(bool back) external {
        calls++;
        nft.setOwner(agentId, makeAddr("buyer"));
        if (back) nft.setOwner(agentId, owner);
    }

    function warp(uint256 seconds_) external {
        calls++;
        vm.warp(block.timestamp + bound(seconds_, 1, 20 days));
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
        uint256 w = which % 9;
        if (w == 0) {
            try factory.setPersonalCap(bound(value, 0, factory.personalCap())) {} catch {}
        } else if (w == 1) {
            try factory.setPlatformCap(bound(value, 0, factory.platformCap())) {} catch {}
        } else if (w == 2) {
            try factory.removeDepositor(owner) {} catch {}
        } else if (w == 3) {
            try factory.enableAllowlist() {} catch {}
        } else if (w == 4) {
            try factory.removeBuyable(address(wmon)) {} catch {}
        } else if (w == 5) {
            try factory.clearExecutor() {} catch {}
        } else if (w == 6) {
            AccountFactory.Action a = AccountFactory.Action(4 + value % 5);
            bytes32 v = a == AccountFactory.Action.RaisePersonalCap || a == AccountFactory.Action.RaisePlatformCap
                ? bytes32(bound(value, 0, 10_000e6))
                : a == AccountFactory.Action.DisableAllowlist
                    ? bytes32(0)
                    : a == AccountFactory.Action.AddBuyable
                        ? bytes32(uint256(uint160(address(wmon))))
                        : bytes32(uint256(uint160(owner)));
            try factory.propose(a, v) {} catch {}
            vm.stopPrank();
            vm.warp(block.timestamp + 9 days);
            try factory.execute(a, v) {} catch {}
            return;
        } else if (w == 7) {
            try factory.propose(AccountFactory.Action.SetGuardian, bytes32(uint256(uint160(guardian)))) {} catch {}
        } else {
            try factory.cancel(
                factory.changeId(AccountFactory.Action.SetGuardian, bytes32(uint256(uint160(guardian))))
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
        SwapParams memory p = SwapParams({
            tokenIn: address(t),
            tokenOut: t == usdc ? address(wmon) : address(usdc),
            amountIn: amount,
            minAmountOut: 1,
            poolId: bytes32(0),
            deadline: uint64(block.timestamp + 60),
            ownershipEpoch: nft.ownerEpoch(agentId),
            configEpoch: 0
        });
        bytes memory data;
        uint256 w = which % 6;
        if (w == 0) data = abi.encodeCall(CustodyCore.withdraw, (address(t), amount, actor));
        else if (w == 1) data = abi.encodeCall(CustodyCore.withdrawAll, (actor));
        else if (w == 2) data = abi.encodeCall(CustodyCore.claim, (address(t), actor));
        else if (w == 3) data = abi.encodeCall(CustodyCore.pullForSwap, (address(t), amount));
        else if (w == 4) data = abi.encodeCall(CustodyCore.executeSwap, (p));
        else data = abi.encodeCall(PersonalAccount.initialize, (agentId, actor));
        vm.prank(actor);
        (bool ok,) = address(account).call(data);
        if (ok) {
            unauthorizedSuccess = true;
            unauthorizedWhat = string.concat("call ", vm.toString(w), " by ", vm.toString(actor));
        }
    }
}

contract CustodyInvariantTest is CustodyBase {
    CustodyHandler internal handler;

    function setUp() public override {
        super.setUp();
        setOracle();
        handler =
            new CustodyHandler(account, factory, usdc, wmon, nft, oracle, [owner, admin, guardian, sentinel], AGENT);
        targetContract(address(handler));
    }

    /// Conservation: what entered is in the account or with the owner's recipient.
    function invariant_FundsLeaveOnlyThroughTheOwnersWithdrawal() public view {
        address sink = handler.SINK();
        assertEq(usdcBal(address(account)) + usdcBal(sink), handler.totalIn(address(usdc)), "USDC");
        assertEq(wmonBal(address(account)) + wmonBal(sink), handler.totalIn(address(wmon)), "WMON");
    }

    function invariant_NoOneElseEverMovesFundsOrTrades() public view {
        assertFalse(handler.unauthorizedSuccess(), handler.unauthorizedWhat());
    }

    function invariant_TheExecutorStaysUnset() public view {
        assertEq(factory.executor(), address(0));
    }

    function invariant_ACreditNeverExceedsTheBalance() public view {
        assertLe(account.claimable(address(usdc)), usdcBal(address(account)));
        assertLe(account.claimable(address(wmon)), wmonBal(address(account)));
    }

    /// One account: the platform total is exactly its principal.
    function invariant_ThePlatformTotalIsThePrincipal() public view {
        assertEq(factory.platformTotal(), account.principal());
    }

    /// Counts what the runs did, so a run that only reverted cannot pass unseen.
    function afterInvariant() public view {
        assertGt(handler.calls(), 0);
    }
}

/// Anyone but the owner, with any calldata at all, moves nothing.
contract CustodyFuzzTest is CustodyBase {
    function testFuzz_AnyCallByAnyoneButTheOwnerMovesNothing(address caller, bytes calldata data) public {
        vm.assume(caller != owner);
        setOracle();
        deposit(usdc, 50e6);
        deposit(wmon, 40e18);
        vm.prank(caller);
        (bool ok,) = address(account).call(data);
        ok;
        vm.prank(caller);
        (ok,) = address(factory).call(data);
        assertEq(usdcBal(address(account)), 50e6);
        assertEq(wmonBal(address(account)), 40e18);
    }

    function testFuzz_TheOwnerWithdrawsAnyAmountUpToTheBalance(uint256 amount, address to) public {
        vm.assume(to != address(0) && to != address(account));
        deposit(usdc, 80e6);
        amount = bound(amount, 1, 80e6);
        uint256 before = usdcBal(to);
        vm.prank(owner);
        account.withdraw(address(usdc), amount, to);
        assertEq(usdcBal(to) - before, amount);
        assertEq(usdcBal(address(account)), 80e6 - amount);
        assertEq(account.principal(), 80e6 - amount);
    }
}

/// Probe (L-40): one long sequence through the handler's own entry points
/// reaches deposits, withdrawals and credits; kept as a test so it runs every time.
contract CustodyHandlerProbe is CustodyBase {
    function test_TheHandlerReachesDepositsWithdrawalsAndCredits() public {
        setOracle();
        CustodyHandler h =
            new CustodyHandler(account, factory, usdc, wmon, nft, oracle, [owner, admin, guardian, sentinel], AGENT);
        for (uint256 i = 0; i < 60; i++) {
            uint256 r = uint256(keccak256(abi.encode(i)));
            if (i % 5 == 0) h.ownerDeposit(r, r >> 8);
            else if (i % 5 == 1) h.setUsdcBlock(r);
            else if (i % 5 == 2) h.ownerWithdrawAll();
            else if (i % 5 == 3) h.ownerWithdraw(r, r >> 8);
            else h.intrude(r, r >> 8, r >> 16);
        }
        assertGt(h.deposits(), 0);
        assertGt(h.withdrawals(), 0);
        assertGt(h.credits(), 0);
        assertFalse(h.unauthorizedSuccess());
    }
}
