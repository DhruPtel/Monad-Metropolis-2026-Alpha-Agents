// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AccountFactory} from "../../src/custody/AccountFactory.sol";
import {MockToken} from "../mocks/CustodyMocks.sol";
import {CustodyBase} from "./CustodyBase.sol";

/// AccountFactory: caps, allowlist, buy list, roles and the in-contract timelock (P2-U1).
contract AccountFactoryTest is CustodyBase {
    bytes32 internal constant NONE = bytes32(0);

    function addr(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    // ----- deployment state -----

    function test_StartsWithTheBetaConfiguration() public view {
        assertEq(factory.owner(), admin);
        assertEq(factory.guardian(), guardian);
        assertEq(factory.sentinel(), sentinel);
        assertEq(factory.executor(), address(0));
        assertEq(factory.oracle(), address(0));
        assertEq(factory.personalCap(), 100e6);
        assertEq(factory.platformCap(), 2_000e6);
        assertTrue(factory.allowlistEnabled());
        assertTrue(factory.isAllowlisted(owner));
        assertFalse(factory.isAllowlisted(stranger));
        assertTrue(factory.isBuyable(address(usdc)));
        assertTrue(factory.isBuyable(address(wmon)));
        assertEq(factory.RISK_TIMELOCK(), 9 days);
    }

    // ----- the timelock -----

    function test_AChangeWaitsTheFullTimelock_ThenAnyoneExecutesIt() public {
        vm.prank(admin);
        bytes32 id = factory.propose(AccountFactory.Action.SetExecutor, addr(address(executor)));
        (uint64 executableAt, uint64 expiresAt) = factory.pending(id);
        assertEq(executableAt, block.timestamp + 9 days);
        assertEq(expiresAt, block.timestamp + 16 days);

        vm.warp(executableAt - 1);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.TooEarly.selector, executableAt));
        factory.execute(AccountFactory.Action.SetExecutor, addr(address(executor)));
        assertEq(factory.executor(), address(0));

        vm.warp(executableAt);
        vm.prank(stranger);
        factory.execute(AccountFactory.Action.SetExecutor, addr(address(executor)));
        assertEq(factory.executor(), address(executor));
        // Executed once: the same change cannot run twice.
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.NotPending.selector, id));
        factory.execute(AccountFactory.Action.SetExecutor, addr(address(executor)));
    }

    function test_EveryTimelockedActionWaits() public {
        bytes32[9] memory values = [
            addr(address(executor)),
            addr(address(oracle)),
            addr(makeAddr("new guardian")),
            addr(makeAddr("new sentinel")),
            bytes32(uint256(500e6)),
            bytes32(uint256(5_000e6)),
            addr(stranger),
            NONE,
            addr(address(wmon))
        ];
        for (uint256 i = 0; i < 9; i++) {
            AccountFactory.Action action = AccountFactory.Action(i);
            vm.prank(admin);
            bytes32 id = factory.propose(action, values[i]);
            (uint64 executableAt,) = factory.pending(id);
            vm.expectRevert(abi.encodeWithSelector(AccountFactory.TooEarly.selector, executableAt));
            factory.execute(action, values[i]);
        }
        vm.warp(block.timestamp + 9 days);
        for (uint256 i = 0; i < 9; i++) {
            factory.execute(AccountFactory.Action(i), values[i]);
        }
        assertEq(factory.executor(), address(executor));
        assertEq(factory.oracle(), address(oracle));
        assertEq(factory.guardian(), makeAddr("new guardian"));
        assertEq(factory.sentinel(), makeAddr("new sentinel"));
        assertEq(factory.personalCap(), 500e6);
        assertEq(factory.platformCap(), 5_000e6);
        assertTrue(factory.isAllowlisted(stranger));
        assertFalse(factory.allowlistEnabled());
    }

    function test_AMaturedChangeLapses_AndCanBeProposedAgain() public {
        vm.prank(admin);
        bytes32 id = factory.propose(AccountFactory.Action.SetOracle, addr(address(oracle)));
        (, uint64 expiresAt) = factory.pending(id);
        vm.warp(expiresAt + 1);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.Lapsed.selector, expiresAt));
        factory.execute(AccountFactory.Action.SetOracle, addr(address(oracle)));
        vm.prank(admin);
        factory.propose(AccountFactory.Action.SetOracle, addr(address(oracle)));
    }

    function test_OnlyTheAdminProposes_AndNotTwice() public {
        address[3] memory others = [stranger, guardian, sentinel];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]));
            factory.propose(AccountFactory.Action.SetExecutor, addr(others[i]));
        }
        vm.startPrank(admin);
        bytes32 id = factory.propose(AccountFactory.Action.SetExecutor, addr(address(executor)));
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.AlreadyPending.selector, id));
        factory.propose(AccountFactory.Action.SetExecutor, addr(address(executor)));
        vm.stopPrank();
    }

    function test_TheAdminOrGuardianCancels_NobodyElse() public {
        vm.prank(admin);
        bytes32 id = factory.propose(AccountFactory.Action.SetExecutor, addr(address(executor)));
        vm.prank(sentinel);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.NotAdminOrGuardian.selector, sentinel));
        factory.cancel(id);
        vm.prank(guardian);
        factory.cancel(id);
        vm.warp(block.timestamp + 9 days);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.NotPending.selector, id));
        factory.execute(AccountFactory.Action.SetExecutor, addr(address(executor)));
    }

    function test_ProposalsTakeOneEncodingPerValue() public {
        vm.startPrank(admin);
        bytes32 dirty = bytes32(uint256(1) << 200 | uint256(uint160(address(executor))));
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.BadValue.selector, dirty));
        factory.propose(AccountFactory.Action.SetExecutor, dirty);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.BadValue.selector, bytes32(uint256(1))));
        factory.propose(AccountFactory.Action.DisableAllowlist, bytes32(uint256(1)));
        vm.stopPrank();
    }

    // ----- instant tightening -----

    function test_CapsLowerAtOnce_AndRaiseOnlyByTimelock() public {
        vm.startPrank(admin);
        factory.setPersonalCap(50e6);
        factory.setPlatformCap(1_000e6);
        vm.expectRevert(AccountFactory.UseTimelock.selector);
        factory.setPersonalCap(50e6 + 1);
        vm.expectRevert(AccountFactory.UseTimelock.selector);
        factory.setPlatformCap(1_000e6 + 1);
        vm.stopPrank();
        assertEq(factory.personalCap(), 50e6);
        timelocked(AccountFactory.Action.RaisePersonalCap, bytes32(uint256(80e6)));
        assertEq(factory.personalCap(), 80e6);
    }

    function test_OnlyTheAdminLowersCaps() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        factory.setPersonalCap(0);
    }

    function test_TheAllowlistTightensAtOnce_AndLoosensOnlyByTimelock() public {
        vm.startPrank(admin);
        factory.removeDepositor(owner);
        assertFalse(factory.isAllowlisted(owner));
        factory.enableAllowlist();
        vm.stopPrank();
        // A removed depositor cannot deposit, and can still withdraw.
        usdc.mint(owner, 1e6);
        vm.startPrank(owner);
        usdc.approve(address(account), 1e6);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.NotAllowlisted.selector, owner));
        account.deposit(address(usdc), 1e6);
        vm.stopPrank();
        timelocked(AccountFactory.Action.AllowDepositor, addr(owner));
        deposit(usdc, 1e6);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 2e6);

        timelocked(AccountFactory.Action.DisableAllowlist, NONE);
        assertFalse(factory.allowlistEnabled());
        vm.prank(admin);
        factory.enableAllowlist();
        assertTrue(factory.allowlistEnabled());
    }

    function test_TheBuyListShrinksAtOnce_AndGrowsOnlyByTimelockAndOnlyWithHeldAssets() public {
        vm.prank(admin);
        factory.removeBuyable(address(wmon));
        assertFalse(factory.isBuyable(address(wmon)));
        MockToken other = new MockToken("OTHER", 18);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.NotHeldAsset.selector, address(other)));
        factory.propose(AccountFactory.Action.AddBuyable, addr(address(other)));
        timelocked(AccountFactory.Action.AddBuyable, addr(address(wmon)));
        assertTrue(factory.isBuyable(address(wmon)));
    }

    function test_TheAdminOrGuardianClearsTheExecutor_NobodyElse() public {
        setExecutor();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.NotAdminOrGuardian.selector, stranger));
        factory.clearExecutor();
        vm.prank(guardian);
        factory.clearExecutor();
        assertEq(factory.executor(), address(0));
        setExecutor();
        vm.prank(admin);
        factory.clearExecutor();
        assertEq(factory.executor(), address(0));
    }

    /// A guardian is appointed only by timelock; the old one loses its powers then.
    function test_ANewGuardianWaitsTheTimelock() public {
        address next = makeAddr("next guardian");
        timelocked(AccountFactory.Action.SetGuardian, addr(next));
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.NotAdminOrGuardian.selector, guardian));
        factory.clearExecutor();
        vm.prank(next);
        factory.clearExecutor();
    }

    // ----- bookkeeping is for accounts only -----

    function test_OnlyAccountsRecord() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.NotAnAccount.selector, stranger));
        factory.recordDeposit(stranger, 0, 0);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.NotAnAccount.selector, admin));
        factory.recordWithdrawal(0);
    }

    // ----- admin -----

    function test_AdminIsTwoStep_AndCannotBeRenounced() public {
        address next = makeAddr("next admin");
        vm.prank(admin);
        factory.transferOwnership(next);
        assertEq(factory.owner(), admin);
        vm.prank(next);
        factory.acceptOwnership();
        assertEq(factory.owner(), next);
        vm.prank(next);
        vm.expectRevert(AccountFactory.RenounceDisabled.selector);
        factory.renounceOwnership();
    }

    // ----- fuzz -----

    /// Whatever the cap and the amounts, principal never passes the cap and the
    /// platform total equals the sum of what was recorded.
    function testFuzz_CapsHold(uint96 cap, uint96 first, uint96 second) public {
        cap = uint96(bound(cap, 1, 100e6));
        vm.prank(admin);
        factory.setPersonalCap(cap);
        uint256 a = bound(first, 1, 200e6);
        uint256 b = bound(second, 1, 200e6);
        usdc.mint(owner, a + b);
        vm.startPrank(owner);
        usdc.approve(address(account), a + b);
        bool firstOk = a <= cap;
        if (!firstOk) vm.expectRevert();
        account.deposit(address(usdc), a);
        uint256 held = firstOk ? a : 0;
        bool secondOk = held + b <= cap;
        if (!secondOk) vm.expectRevert();
        account.deposit(address(usdc), b);
        vm.stopPrank();
        held += secondOk ? b : 0;
        assertEq(account.principal(), held);
        assertEq(factory.platformTotal(), held);
        assertLe(account.principal(), cap);
    }
}
