// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccountFactory} from "../../src/custody/AccountFactory.sol";
import {CustodyCore} from "../../src/custody/CustodyCore.sol";
import {PersonalAccount} from "../../src/custody/PersonalAccount.sol";
import {AccountMode, IAgentNFTView, SwapParams} from "../../src/interfaces/ICustody.sol";
import {IOracleAdapter, OracleReason} from "../../src/interfaces/IOracle.sol";
import {FeeOnTransferToken, GasBurner, MockExecutor, MockToken, RevertingLedger} from "../mocks/CustodyMocks.sol";
import {CustodyBase} from "./CustodyBase.sol";

/// Every rule of the custody core in single-owner mode (P2-U1).
contract PersonalAccountTest is CustodyBase {
    // =====================================================================
    // Creation
    // =====================================================================

    function test_CreatesOneAccountPerAgentAndOwner_AtThePredictedAddress() public view {
        assertEq(address(account), factory.predictPersonalAccount(AGENT, owner));
        assertEq(factory.personalAccountOf(AGENT, owner), address(account));
        assertTrue(factory.isAccount(address(account)));
        assertEq(account.owner(), owner);
        assertEq(account.agentId(), AGENT);
        assertEq(address(account.config()), address(factory));
        assertEq(account.heldAssets().length, 2);
    }

    function test_OnlyTheAgentsOwnerCreates_AndOnlyOnce() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.NotAgentOwner.selector, stranger, owner));
        factory.createPersonalAccount(AGENT);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.AccountExists.selector, address(account)));
        factory.createPersonalAccount(AGENT);
    }

    function test_InitializesOnce_AndTheImplementationIsLocked() public {
        vm.expectRevert(PersonalAccount.AlreadyInitialized.selector);
        account.initialize(1, stranger);
        PersonalAccount impl = PersonalAccount(factory.PERSONAL_ACCOUNT_IMPLEMENTATION());
        vm.expectRevert(PersonalAccount.AlreadyInitialized.selector);
        impl.initialize(1, stranger);
    }

    function test_ABuyerGetsTheirOwnAccount_TheSellerKeepsTheirs() public {
        address buyer = makeAddr("buyer");
        nft.setOwner(AGENT, buyer);
        vm.prank(buyer);
        address theirs = factory.createPersonalAccount(AGENT);
        assertTrue(theirs != address(account));
        assertEq(factory.personalAccountOf(AGENT, owner), address(account));
    }

    function test_HasNoReceive_AndRejectsNativeMon() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(account).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(account).balance, 0);
    }

    // =====================================================================
    // Deposits
    // =====================================================================

    function test_DepositsUsdc_CountingPrincipalAndThePlatformTotal() public {
        usdc.mint(owner, 40e6);
        vm.startPrank(owner);
        usdc.approve(address(account), 40e6);
        vm.expectEmit(address(account));
        emit PersonalAccount.Deposited(address(usdc), 40e6, 40e6, 40e6);
        account.deposit(address(usdc), 40e6);
        vm.stopPrank();
        assertEq(usdcBal(address(account)), 40e6);
        assertEq(account.principal(), 40e6);
        assertEq(factory.platformTotal(), 40e6);
    }

    function test_DepositsWmon_ValuedThroughTheOracle_AndRefusedWithoutOne() public {
        deposit(wmon, 10e18);
        assertEq(account.principal(), 5e6);

        // A factory whose oracle was never set refuses every deposit: the
        // depeg guard needs USDC/USD even for USDC (P2-U3).
        address[] memory allow = new address[](1);
        allow[0] = owner;
        AccountFactory bare = new AccountFactory(
            admin,
            guardian,
            sentinel,
            address(0),
            address(0),
            IAgentNFTView(address(nft)),
            address(usdc),
            address(wmon),
            100e6,
            2_000e6,
            allow
        );
        assertEq(bare.oracle(), address(0), "a new factory starts with no oracle");
        vm.prank(owner);
        PersonalAccount fresh = PersonalAccount(bare.createPersonalAccount(AGENT));
        wmon.mint(owner, 10e18);
        usdc.mint(owner, 10e6);
        vm.startPrank(owner);
        wmon.approve(address(fresh), 10e18);
        usdc.approve(address(fresh), 10e6);
        vm.expectRevert(CustodyCore.OracleUnset.selector);
        fresh.deposit(address(wmon), 10e18);
        vm.expectRevert(CustodyCore.OracleUnset.selector);
        fresh.deposit(address(usdc), 10e6);
        vm.stopPrank();
    }

    function test_DepositRefusals() public {
        usdc.mint(owner, 1_000e6);
        vm.prank(owner);
        usdc.approve(address(account), type(uint256).max);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotOwner.selector, stranger));
        account.deposit(address(usdc), 1e6);

        vm.startPrank(owner);
        vm.expectRevert(CustodyCore.ZeroAmount.selector);
        account.deposit(address(usdc), 0);
        MockToken other = new MockToken("OTHER", 6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotHeldAsset.selector, address(other)));
        account.deposit(address(other), 1e6);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.PersonalCapExceeded.selector, 100e6 + 1, PERSONAL_CAP));
        account.deposit(address(usdc), 100e6 + 1);
        vm.stopPrank();
    }

    function test_DepositsAreRefusedWhilePausedOrClosed_ButNotInReduceOnly() public {
        usdc.mint(owner, 10e6);
        vm.prank(owner);
        usdc.approve(address(account), 10e6);
        vm.prank(sentinel);
        account.setReduceOnly();
        vm.prank(owner);
        account.deposit(address(usdc), 1e6);

        vm.prank(sentinel);
        account.pause();
        vm.prank(owner);
        vm.expectRevert(PersonalAccount.DepositsPaused.selector);
        account.deposit(address(usdc), 1e6);

        vm.prank(owner);
        account.unpause();
        vm.prank(guardian);
        account.closeDeposits();
        vm.prank(owner);
        vm.expectRevert(PersonalAccount.DepositsAreClosed.selector);
        account.deposit(address(usdc), 1e6);
        vm.prank(owner);
        account.openDeposits();
        vm.prank(owner);
        account.deposit(address(usdc), 1e6);
    }

    function test_ASellerCannotDepositAfterTheSale() public {
        nft.setOwner(AGENT, makeAddr("buyer"));
        usdc.mint(owner, 1e6);
        vm.startPrank(owner);
        usdc.approve(address(account), 1e6);
        vm.expectRevert(abi.encodeWithSelector(PersonalAccount.NotAgentOwner.selector, makeAddr("buyer")));
        account.deposit(address(usdc), 1e6);
        vm.stopPrank();
    }

    function test_AWalletOffTheAllowlistCannotDeposit() public {
        address outsider = makeAddr("outsider");
        nft.setOwner(99, outsider);
        vm.prank(outsider);
        PersonalAccount theirs = PersonalAccount(factory.createPersonalAccount(99));
        usdc.mint(outsider, 1e6);
        vm.startPrank(outsider);
        usdc.approve(address(theirs), 1e6);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.NotAllowlisted.selector, outsider));
        theirs.deposit(address(usdc), 1e6);
        vm.stopPrank();
    }

    function test_ThePlatformCapSpansAccounts() public {
        vm.prank(admin);
        factory.setPlatformCap(150e6);
        deposit(usdc, 100e6);
        address second = makeAddr("second");
        nft.setOwner(8, second);
        vm.prank(admin);
        factory.addDepositor(second);
        vm.prank(second);
        PersonalAccount other = PersonalAccount(factory.createPersonalAccount(8));
        usdc.mint(second, 60e6);
        vm.startPrank(second);
        usdc.approve(address(other), 60e6);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.PlatformCapExceeded.selector, 160e6, 150e6));
        other.deposit(address(usdc), 60e6);
        other.deposit(address(usdc), 50e6);
        vm.stopPrank();
        assertEq(factory.platformTotal(), 150e6);
    }

    function test_WithdrawingUsdcFreesCapRoom_AndEmptyingTheAccountResetsPrincipal() public {
        setOracle();
        deposit(usdc, 60e6);
        deposit(wmon, 80e18);
        assertEq(account.principal(), 100e6);
        vm.prank(owner);
        account.withdraw(address(usdc), 20e6, owner);
        assertEq(account.principal(), 80e6);
        assertEq(factory.platformTotal(), 80e6);
        // WMON has no oracle-free value: withdrawing some lowers nothing.
        vm.prank(owner);
        account.withdraw(address(wmon), 1e18, owner);
        assertEq(account.principal(), 80e6);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(account.principal(), 0);
        assertEq(factory.platformTotal(), 0);
    }

    function test_RefusesAFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        address[] memory allow = new address[](1);
        allow[0] = owner;
        AccountFactory f = new AccountFactory(
            admin,
            guardian,
            sentinel,
            address(0),
            address(0),
            IAgentNFTView(address(nft)),
            address(fot),
            address(wmon),
            PERSONAL_CAP,
            PLATFORM_CAP,
            allow
        );
        bytes32 oracleValue = bytes32(uint256(uint160(address(oracle))));
        vm.prank(admin);
        f.propose(AccountFactory.Action.SetOracle, oracleValue);
        vm.warp(block.timestamp + 9 days);
        f.execute(AccountFactory.Action.SetOracle, oracleValue);
        vm.prank(owner);
        PersonalAccount a = PersonalAccount(f.createPersonalAccount(AGENT));
        fot.mint(owner, 10e6);
        vm.startPrank(owner);
        fot.approve(address(a), 10e6);
        vm.expectRevert(abi.encodeWithSelector(PersonalAccount.TransferNotExact.selector, address(fot), 9.9e6, 10e6));
        a.deposit(address(fot), 10e6);
        vm.stopPrank();
    }

    // =====================================================================
    // Withdrawals: always on, owner only
    // =====================================================================

    function test_TheOwnerWithdraws_ToAnyAddress() public {
        deposit(usdc, 50e6);
        address elsewhere = makeAddr("elsewhere");
        vm.prank(owner);
        vm.expectEmit(address(account));
        emit CustodyCore.Withdrawn(address(usdc), 30e6, elsewhere);
        account.withdraw(address(usdc), 30e6, elsewhere);
        assertEq(usdcBal(elsewhere), 30e6);
        assertEq(usdcBal(address(account)), 20e6);
    }

    function test_TheOwnerWithdrawsInEveryModeAndWithDepositsClosed() public {
        setOracle();
        deposit(usdc, 30e6);
        deposit(wmon, 20e18);
        vm.startPrank(sentinel);
        account.setReduceOnly();
        account.closeDeposits();
        vm.stopPrank();
        vm.prank(owner);
        account.withdraw(address(usdc), 1e6, owner);
        vm.prank(guardian);
        account.pause();
        assertMode(AccountMode.PAUSED);
        vm.prank(owner);
        account.withdraw(address(wmon), 1e18, owner);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(address(account)) + wmonBal(address(account)), 0);
        assertEq(usdcBal(owner), 30e6);
        assertEq(wmonBal(owner), 20e18);
    }

    /// The withdrawal needs nothing but the owner and the token: the factory,
    /// AgentNFT, oracle and Executor may all be broken.
    function test_WithdrawalWorksWithEveryOtherContractBroken() public {
        tradingAccount();
        vm.etch(address(factory), address(new RevertingLedger()).code);
        vm.etch(address(nft), address(new RevertingLedger()).code);
        vm.etch(address(oracle), address(new RevertingLedger()).code);
        vm.etch(address(executor), address(new RevertingLedger()).code);
        vm.prank(owner);
        account.withdraw(address(usdc), 10e6, owner);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 60e6);
        assertEq(wmonBal(owner), 80e18);
    }

    function test_WithdrawalWorksWhenTheFactoryBurnsAllGasOrHasNoCode() public {
        deposit(usdc, 50e6);
        vm.etch(address(factory), address(new GasBurner()).code);
        vm.prank(owner);
        account.withdraw(address(usdc), 10e6, owner);
        vm.etch(address(factory), "");
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 50e6);
    }

    function test_NobodyButTheOwnerWithdraws() public {
        deposit(usdc, 50e6);
        address[6] memory others = [stranger, admin, guardian, sentinel, address(factory), address(executor)];
        for (uint256 i = 0; i < others.length; i++) {
            vm.startPrank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotOwner.selector, others[i]));
            account.withdraw(address(usdc), 1, others[i]);
            vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotOwner.selector, others[i]));
            account.withdrawAll(others[i]);
            vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotOwner.selector, others[i]));
            account.claim(address(usdc), others[i]);
            vm.stopPrank();
        }
        assertEq(usdcBal(address(account)), 50e6);
    }

    function test_WithdrawalRefusesABadRecipientOrZero() public {
        deposit(usdc, 5e6);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.BadRecipient.selector, address(0)));
        account.withdraw(address(usdc), 1, address(0));
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.BadRecipient.selector, address(account)));
        account.withdrawAll(address(account));
        vm.expectRevert(CustodyCore.ZeroAmount.selector);
        account.withdraw(address(usdc), 0, owner);
        vm.stopPrank();
    }

    function test_ASellerKeepsTheirWithdrawal_AndTheBuyerCannotTouchIt() public {
        deposit(usdc, 50e6);
        address buyer = makeAddr("buyer");
        nft.setOwner(AGENT, buyer);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotOwner.selector, buyer));
        account.withdraw(address(usdc), 1, buyer);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 50e6);
    }

    function test_AStrayTokenCanBeWithdrawn() public {
        MockToken stray = new MockToken("STRAY", 18);
        stray.mint(address(account), 5e18);
        vm.prank(owner);
        account.withdraw(address(stray), 5e18, owner);
        assertEq(stray.balanceOf(owner), 5e18);
    }

    // =====================================================================
    // A reverting token: skipped, credited, claimable later (D-071)
    // =====================================================================

    function test_ABlacklistedTokenIsCredited_AndTheRestStillWithdraws() public {
        setOracle();
        deposit(usdc, 40e6);
        deposit(wmon, 20e18);
        usdc.setBlocked(address(account), true);

        vm.prank(owner);
        vm.expectEmit(address(account));
        emit CustodyCore.ClaimableCredited(address(usdc), 40e6, 40e6);
        account.withdrawAll(owner);
        assertEq(wmonBal(owner), 20e18);
        assertEq(usdcBal(address(account)), 40e6);
        assertEq(account.claimable(address(usdc)), 40e6);
        assertEq(account.freeBalance(address(usdc)), 0);
        // Credits are excluded from valuation.
        assertEq(account.navUsdc(), 0);

        vm.prank(owner);
        vm.expectRevert();
        account.claim(address(usdc), owner);
        assertEq(account.claimable(address(usdc)), 40e6);

        usdc.setBlocked(address(account), false);
        address elsewhere = makeAddr("elsewhere");
        vm.prank(owner);
        account.claim(address(usdc), elsewhere);
        assertEq(usdcBal(elsewhere), 40e6);
        assertEq(account.claimable(address(usdc)), 0);
        assertEq(account.principal(), 0);
    }

    function test_APausedTokenIsCredited_AndABlacklistedOwnerClaimsToAnotherAddress() public {
        deposit(usdc, 40e6);
        usdc.setBlocked(owner, true);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(account.claimable(address(usdc)), 40e6);
        address safe = makeAddr("safe");
        vm.prank(owner);
        account.claim(address(usdc), safe);
        assertEq(usdcBal(safe), 40e6);
        usdc.setBlocked(owner, false);

        deposit(usdc, 10e6);
        usdc.setPaused(true);
        vm.prank(owner);
        account.withdrawAll(safe);
        assertEq(account.claimable(address(usdc)), 10e6);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.NothingToClaim.selector, address(wmon)));
        account.claim(address(wmon), safe);
    }

    function test_AWithdrawalOfACreditedTokenLowersTheCredit() public {
        deposit(usdc, 40e6);
        usdc.setBlocked(address(account), true);
        vm.prank(owner);
        account.withdrawAll(owner);
        usdc.setBlocked(address(account), false);
        vm.prank(owner);
        account.withdraw(address(usdc), 30e6, owner);
        assertEq(account.claimable(address(usdc)), 10e6);
        // A later withdrawAll that succeeds clears what is left.
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(account.claimable(address(usdc)), 0);
        assertEq(usdcBal(owner), 40e6);
    }

    // =====================================================================
    // Modes and roles (A-22, D-138)
    // =====================================================================

    function test_OwnerGuardianAndSentinelTighten() public {
        address[3] memory tighteners = [owner, guardian, sentinel];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(owner);
            account.unpause();
            vm.prank(owner);
            account.openDeposits();
            vm.startPrank(tighteners[i]);
            vm.expectEmit(address(account));
            emit CustodyCore.ModeChanged(AccountMode.NORMAL, AccountMode.REDUCE_ONLY, tighteners[i]);
            account.setReduceOnly();
            account.pause();
            account.closeDeposits();
            vm.stopPrank();
            assertMode(AccountMode.PAUSED);
            assertTrue(account.depositsClosed());
        }
    }

    function test_NobodyElseTightens() public {
        address[3] memory others = [stranger, admin, address(factory)];
        for (uint256 i = 0; i < 3; i++) {
            vm.startPrank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotTightener.selector, others[i]));
            account.setReduceOnly();
            vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotTightener.selector, others[i]));
            account.pause();
            vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotTightener.selector, others[i]));
            account.closeDeposits();
            vm.stopPrank();
        }
    }

    /// The sentinel and the guardian only tighten: no unpause, no reopening,
    /// and reduce-only never loosens a pause.
    function test_TheSentinelAndGuardianCannotLoosen() public {
        vm.prank(sentinel);
        account.pause();
        vm.prank(sentinel);
        account.setReduceOnly();
        assertMode(AccountMode.PAUSED);
        vm.prank(sentinel);
        account.closeDeposits();
        address[2] memory roles = [sentinel, guardian];
        for (uint256 i = 0; i < 2; i++) {
            vm.startPrank(roles[i]);
            vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotOwner.selector, roles[i]));
            account.unpause();
            vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotOwner.selector, roles[i]));
            account.openDeposits();
            vm.stopPrank();
        }
        assertMode(AccountMode.PAUSED);
        assertTrue(account.depositsClosed());
        vm.prank(owner);
        account.unpause();
        assertMode(AccountMode.NORMAL);
    }

    /// The sentinel has no power in the factory at all.
    function test_TheSentinelCannotTouchTheFactory() public {
        vm.startPrank(sentinel);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.NotAdminOrGuardian.selector, sentinel));
        factory.clearExecutor();
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.NotAdminOrGuardian.selector, sentinel));
        factory.cancel(bytes32(0));
        vm.expectRevert();
        factory.propose(AccountFactory.Action.SetSentinel, bytes32(uint256(uint160(sentinel))));
        vm.expectRevert();
        factory.setPersonalCap(0);
        vm.stopPrank();
    }

    function test_RepeatedTighteningIsANoOp() public {
        vm.startPrank(sentinel);
        account.setReduceOnly();
        vm.recordLogs();
        account.setReduceOnly();
        assertEq(vm.getRecordedLogs().length, 0);
        vm.stopPrank();
    }

    // =====================================================================
    // Trading: the Executor's one path and the core's backstops
    // =====================================================================

    function test_NobodyTradesWhileTheExecutorIsUnset() public {
        setOracle();
        deposit(usdc, 50e6);
        SwapParams memory p = params(address(usdc), address(wmon), 1e6);
        address[5] memory callers = [owner, admin, guardian, address(factory), address(executor)];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotExecutor.selector, callers[i]));
            account.executeSwap(p);
        }
    }

    function test_AnHonestSwapPasses_AndLeavesNoAllowance() public {
        tradingAccount();
        SwapParams memory p = params(address(usdc), address(wmon), 4e6);
        uint256 navBefore = account.navUsdc();
        executor.swap(account, p);
        assertEq(usdcBal(address(account)), 56e6);
        assertEq(wmonBal(address(account)), 88e18);
        assertEq(account.navUsdc(), navBefore);
        assertEq(usdc.allowance(address(account), address(executor)), 0);
        assertEq(usdcBal(address(executor)), 4e6);
    }

    function test_OnlyTheExecutorSwaps_AndPullsOnlyInsideASwap() public {
        tradingAccount();
        SwapParams memory p = params(address(usdc), address(wmon), 1e6);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotExecutor.selector, stranger));
        account.executeSwap(p);
        vm.prank(address(executor));
        vm.expectRevert(CustodyCore.SwapContextInvalid.selector);
        account.pullForSwap(address(usdc), 1e6);
        vm.prank(stranger);
        vm.expectRevert(CustodyCore.SwapContextInvalid.selector);
        account.pullForSwap(address(usdc), 1e6);
    }

    /// MV-S5: the core catches a buggy or compromised Executor on its own.
    function test_TheCoreCatchesAMisbehavingExecutor() public {
        tradingAccount();
        SwapParams memory p = params(address(usdc), address(wmon), 5e6);
        _expectSwapRevert(
            MockExecutor.Behaviour.PullTwice, p, abi.encodeWithSelector(CustodyCore.SwapContextInvalid.selector)
        );
        _expectSwapRevert(
            MockExecutor.Behaviour.PullMore, p, abi.encodeWithSelector(CustodyCore.SwapContextInvalid.selector)
        );
        _expectSwapRevert(
            MockExecutor.Behaviour.PullOtherToken, p, abi.encodeWithSelector(CustodyCore.SwapContextInvalid.selector)
        );
        _expectSwapRevert(
            MockExecutor.Behaviour.PayNothing, p, abi.encodeWithSelector(CustodyCore.OutputTooLow.selector, 0, 1)
        );
        _expectSwapRevert(
            MockExecutor.Behaviour.PayWrongToken, p, abi.encodeWithSelector(CustodyCore.OutputTooLow.selector, 0, 1)
        );
        _expectSwapRevert(
            MockExecutor.Behaviour.PayLess, p, abi.encodeWithSelector(CustodyCore.SlippageTooHigh.selector, 5e6, 2.5e6)
        );
        _expectSwapRevert(
            MockExecutor.Behaviour.ReenterExecute,
            p,
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        _expectSwapRevert(
            MockExecutor.Behaviour.ReenterWithdraw,
            p,
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(usdcBal(address(account)), 60e6);
        assertEq(wmonBal(address(account)), 80e18);
    }

    function _expectSwapRevert(MockExecutor.Behaviour b, SwapParams memory p, bytes memory err) internal {
        executor.setBehaviour(b);
        vm.expectRevert(err);
        executor.swap(account, p);
        executor.setBehaviour(MockExecutor.Behaviour.Honest);
    }

    function test_TheMinimumOutputHolds() public {
        tradingAccount();
        SwapParams memory p = params(address(usdc), address(wmon), 5e6);
        p.minAmountOut = 10e18 + 1;
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.OutputTooLow.selector, 10e18, 10e18 + 1));
        executor.swap(account, p);
    }

    function test_SlippageBackstopAtOnePercent() public {
        tradingAccount();
        SwapParams memory p = params(address(wmon), address(usdc), 20e18);
        executor.setOutputBps(9_900);
        executor.swap(account, p);
        executor.setOutputBps(9_899);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.SlippageTooHigh.selector, 10e6, 9.899e6));
        executor.swap(account, p);
    }

    function test_TradeSizeBackstopAtTwelvePercent() public {
        tradingAccount();
        // NAV 100 USDC: 12 passes, 12.000001 does not.
        SwapParams memory q1 = params(address(usdc), address(wmon), 12e6 + 1);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.TradeTooLarge.selector, 12e6 + 1, 100e6));
        executor.swap(account, q1);
        executor.swap(account, params(address(wmon), address(usdc), 24e18));
    }

    function test_ConcentrationBackstopAtFortyFivePercent() public {
        tradingAccount();
        // WMON is 40 of 100: buying 5 more reaches exactly 45%, then any more is refused.
        executor.swap(account, params(address(usdc), address(wmon), 5e6));
        SwapParams memory q2 = params(address(usdc), address(wmon), 1e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.ConcentrationTooHigh.selector, address(wmon), 46e6, 100e6));
        executor.swap(account, q2);
        // Selling into USDC is never limited by concentration.
        executor.swap(account, params(address(wmon), address(usdc), 20e18));
    }

    function test_ReduceOnlyAndPausedAllowOnlySwapsIntoUsdc() public {
        tradingAccount();
        AccountMode[2] memory modes = [AccountMode.REDUCE_ONLY, AccountMode.PAUSED];
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(sentinel);
            if (modes[i] == AccountMode.REDUCE_ONLY) account.setReduceOnly();
            else account.pause();
            SwapParams memory q3 = params(address(usdc), address(wmon), 1e6);
            vm.expectRevert(abi.encodeWithSelector(CustodyCore.ReduceOnly.selector, modes[i]));
            executor.swap(account, q3);
            executor.swap(account, params(address(wmon), address(usdc), 2e18));
        }
    }

    function test_ASaleStopsTrading_AndAStaleEpochNeverRevives() public {
        tradingAccount();
        SwapParams memory p = params(address(usdc), address(wmon), 1e6);
        address buyer = makeAddr("buyer");
        nft.setOwner(AGENT, buyer);
        vm.expectRevert(abi.encodeWithSelector(PersonalAccount.NotAgentOwner.selector, buyer));
        executor.swap(account, p);
        // Bought back: the owner matches again, but the old intent's epoch is stale.
        nft.setOwner(AGENT, owner);
        vm.expectRevert(abi.encodeWithSelector(PersonalAccount.StaleEpoch.selector, 0, 2));
        executor.swap(account, p);
        executor.swap(account, params(address(usdc), address(wmon), 1e6));
    }

    function test_ExpiredSameTokenAndZeroSwapsAreRefused() public {
        tradingAccount();
        SwapParams memory p = params(address(usdc), address(wmon), 1e6);
        vm.warp(p.deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.Expired.selector, p.deadline));
        executor.swap(account, p);
        SwapParams memory q4 = params(address(usdc), address(usdc), 1e6);
        vm.expectRevert(CustodyCore.SameToken.selector);
        executor.swap(account, q4);
        SwapParams memory q5 = params(address(usdc), address(wmon), 0);
        vm.expectRevert(CustodyCore.ZeroAmount.selector);
        executor.swap(account, q5);
        MockToken other = new MockToken("OTHER", 6);
        SwapParams memory q6 = params(address(usdc), address(other), 1e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotHeldAsset.selector, address(other)));
        executor.swap(account, q6);
    }

    /// The held list is separate from the buy list (D-056): no longer buyable,
    /// still sellable and still withdrawable.
    function test_ATokenOffTheBuyListIsStillSoldAndWithdrawn() public {
        tradingAccount();
        vm.prank(admin);
        factory.removeBuyable(address(wmon));
        SwapParams memory q7 = params(address(usdc), address(wmon), 1e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotBuyable.selector, address(wmon)));
        executor.swap(account, q7);
        executor.swap(account, params(address(wmon), address(usdc), 2e18));
        vm.prank(owner);
        account.withdraw(address(wmon), 78e18, owner);
        assertEq(wmonBal(owner), 78e18);
    }

    function test_TradingFailsClosedOnTheOracle_WithdrawalDoesNot() public {
        tradingAccount();
        oracle.setStale(true);
        SwapParams memory q8 = params(address(usdc), address(wmon), 1e6);
        bytes memory stale =
            abi.encodeWithSelector(IOracleAdapter.OracleUnavailable.selector, address(wmon), OracleReason.STALE);
        vm.expectRevert(stale);
        executor.swap(account, q8);
        vm.expectRevert(stale);
        account.navUsdc();
        vm.expectRevert(stale);
        account.poke();
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 60e6);
    }

    function test_ClearingTheExecutorStopsTradingAtOnce() public {
        tradingAccount();
        vm.prank(guardian);
        factory.clearExecutor();
        SwapParams memory q9 = params(address(usdc), address(wmon), 1e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotExecutor.selector, address(executor)));
        executor.swap(account, q9);
    }

    function test_ACreditCannotBeTraded() public {
        tradingAccount();
        usdc.setBlocked(owner, true);
        vm.prank(owner);
        account.withdrawAll(owner);
        usdc.setBlocked(owner, false);
        assertEq(account.claimable(address(usdc)), 60e6);
        SwapParams memory q10 = params(address(usdc), address(wmon), 1e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.InsufficientFree.selector, address(usdc), 0));
        executor.swap(account, q10);
    }
}
