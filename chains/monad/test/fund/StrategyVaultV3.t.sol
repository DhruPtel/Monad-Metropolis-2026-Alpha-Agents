// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {StrategyVaultV3} from "../../src/fund/StrategyVaultV3.sol";
import {AccountMode} from "../../src/interfaces/ICustody.sol";
import {PriceReason} from "../../src/interfaces/IFund.sol";
import {MockToken, RevertingLedger} from "../mocks/CustodyMocks.sol";
import {BalanceRevertingToken, GasBurningToken, ReturnBombToken} from "../mocks/CustodyV3Mocks.sol";
import {MockFeed} from "../mocks/OracleMocks.sol";
import {VaultHarnessFactory} from "../mocks/VaultMocks.sol";
import {StrategyVaultV3Base} from "./StrategyVaultV3Base.sol";

/// The custody core v3 in public-vault mode (P7-U1): creation, shares at the
/// value plus the spread (M-01, M-02, M-03), the leader stake (M-14 to M-17),
/// lock buckets (M-18 to M-23, MV-S4), the USDC path (M-07 to M-11, as built:
/// USDC above the floor or the in-kind path named), and the in-kind path
/// (M-12, MV-S1, MV-S14) with every hostile token.
contract StrategyVaultV3Test is StrategyVaultV3Base {
    // =====================================================================
    // Creation
    // =====================================================================

    function test_CreatesTheVaultForTheAgentsOwner() public view {
        assertEq(sv.agentId(), AGENT);
        assertEq(sv.leader(), owner);
        assertEq(sv.manager(), owner);
        assertEq(sv.acceptedEpoch(), nft.ownerEpoch(AGENT));
        assertFalse(sv.inHandover());
        assertEq(sv.lockup(), 1 days);
        assertEq(sv.MIN_LOCKUP(), 1 days);
        assertEq(sv.MAX_LOCKUP(), 7 days);
        assertEq(sv.NOTICE(), 2 days);
        assertEq(sv.RISK_TIMELOCK(), sv.MAX_LOCKUP() + sv.NOTICE());
        assertEq(sv.HANDOVER_PERIOD(), 3 days);
        assertTrue(sv.isVault());
        assertFalse(sv.screenedOptIn());
        assertFalse(sv.depositsOpen());
        assertEq(sv.totalSupply(), 0);
        assertEq(sv.feeBps(), 0);
        assertEq(address(sv.config()), address(vaultFactory));
        assertEq(sv.USDC(), address(usdc));
        assertTrue(sv.isHeld(address(usdc)));
        assertEq(sv.heldCount(), 1);
        assertEq(uint8(sv.mode()), uint8(AccountMode.NORMAL));
        assertEq(uint8(sv.effectiveMode()), uint8(AccountMode.NORMAL));
        assertTrue(vaultFactory.isAccount(address(sv)));
    }

    function test_InitializesOnce_AndTheImplementationIsLocked() public {
        vm.expectRevert(StrategyVaultV3.AlreadyInitialized.selector);
        sv.initialize(1, stranger);
        StrategyVaultV3 impl = StrategyVaultV3(vaultFactory.VAULT_IMPLEMENTATION());
        vm.expectRevert(StrategyVaultV3.AlreadyInitialized.selector);
        impl.initialize(1, stranger);
    }

    function test_OnlyTheAgentsOwnerCreatesAVault() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VaultHarnessFactory.NotAgentOwner.selector, stranger, owner));
        vaultFactory.createVault(AGENT);
    }

    function test_HasNoReceive_AndRejectsNativeMon() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(sv).call{value: 1}("");
        assertFalse(ok);
    }

    /// Share transfers are disabled at launch (FINAL_PLAN 4.7.4).
    function test_SharesCannotBeTransferred() public {
        seedAndOpen();
        depositAs(alice, 50e6);
        vm.prank(alice);
        vm.expectRevert(StrategyVaultV3.SharesNotTransferable.selector);
        sv.transfer(bob, 1);
    }

    // =====================================================================
    // The seed, deposits and the share math (M-01, M-03, MV-S12)
    // =====================================================================

    /// Deposits open only once the leader's stake is there (M-03).
    function test_DepositsOpenNeedsTheLeaderSeed() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.LeaderStakeTooLow.selector, 0, 0));
        sv.setDepositsOpen(true);
        vm.prank(alice);
        vm.expectRevert(StrategyVaultV3.DepositsNotOpen.selector);
        sv.deposit(50e6, 0);
        vm.prank(alice);
        vm.expectPartialRevert(StrategyVaultV3.NotManager.selector);
        sv.setDepositsOpen(true);
        seedAndOpen();
        assertTrue(sv.depositsOpen());
        depositAs(alice, 50e6);
        vm.prank(owner);
        sv.setDepositsOpen(false);
        vm.prank(alice);
        vm.expectRevert(StrategyVaultV3.DepositsNotOpen.selector);
        sv.deposit(50e6, 0);
    }

    function test_TheLeaderSeedMintsOneShareOnePerUsdc() public {
        vm.prank(owner);
        vm.expectEmit(address(sv));
        emit StrategyVaultV3.Deposited(owner, SEED, SEED * ONE_SHARE_PER_USDC, 1e18, true);
        uint256 shares = sv.deposit(SEED, 0);
        assertEq(shares, 100e18);
        assertEq(sv.leaderShares(), 100e18);
        assertEq(sv.balanceOf(owner), 0);
        assertEq(sv.sharesOf(owner), 100e18);
        assertEq(sv.totalSupply(), 100e18);
        assertEq(sv.sharePriceE18(), 1e18);
        assertEq(sv.leaderStakeBps(), 10_000);
        assertEq(sv.principal(), SEED);
        assertEq(vaultFactory.platformTotal(), SEED);
        assertEq(sv.entryPriceE18(owner), 1e18);
        (uint256 locked, uint64 unlockAt) = sv.lockOf(owner);
        assertEq(locked, 100e18);
        assertEq(unlockAt, block.timestamp + 1 days);
        assertEq(sv.freeShares(owner), 0);
        assertEq(usdcBal(address(sv)), SEED);
    }

    /// M-01: shares equal the preview, priced at the value plus the 0.5% spread, rounded down.
    function test_ADepositMintsAtTheValuePlusTheSpread_AndMatchesThePreview() public {
        seedAndOpen();
        uint256 preview = sv.convertToShares(100e6);
        uint256 navBuy = 100e6 + Math.mulDiv(100e6, 50, 10_000, Math.Rounding.Ceil);
        uint256 expected = Math.mulDiv(100e6, 100e18 + 1e12, navBuy + 1);
        uint256 shares = depositAs(alice, 100e6);
        assertEq(shares, preview);
        assertEq(shares, expected);
        assertLt(shares, 100e18, "the spread prices the shares above the value");
        assertEq(sv.sharesOf(alice), shares);
        assertEq(sv.balanceOf(alice), shares);
        assertEq(sv.totalSupply(), 100e18 + shares);
        assertGt(sv.sharePriceE18(), 1e18, "the spread stays in the vault");
        assertEq(sv.entryPriceE18(alice), Math.mulDiv(100e6, 1e30, shares));
        assertEq(sv.principal(), 200e6);
        assertEq(sv.navUsdc(), 200e6);
    }

    function test_MinSharesOutIsHonored() public {
        seedAndOpen();
        uint256 preview = sv.convertToShares(10e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.SharesTooFew.selector, preview, preview + 1));
        sv.deposit(10e6, preview + 1);
        vm.prank(alice);
        assertEq(sv.deposit(10e6, preview), preview);
    }

    function test_DepositRefusals() public {
        seedAndOpen();
        vm.prank(alice);
        vm.expectRevert(CustodyCoreV3.ZeroAmount.selector);
        sv.deposit(0, 0);

        // The tighteners' close stops everyone, the leader too; reduce-only stops nobody.
        vm.prank(sentinel);
        sv.closeDeposits();
        vm.prank(alice);
        vm.expectRevert(StrategyVaultV3.DepositsAreClosed.selector);
        sv.deposit(1e6, 0);
        vm.prank(owner);
        vm.expectRevert(StrategyVaultV3.DepositsAreClosed.selector);
        sv.deposit(1e6, 0);
        vm.prank(owner);
        sv.openDeposits();
        vm.prank(guardian);
        sv.setReduceOnly();
        depositAs(alice, 1e6);

        vm.prank(guardian);
        sv.pause();
        vm.prank(alice);
        vm.expectRevert(StrategyVaultV3.DepositsPaused.selector);
        sv.deposit(1e6, 0);
        warpDays(1);
        vm.prank(owner);
        sv.unpause();

        // The factory's allowlist and cap, as for personal accounts.
        vaultFactory.setAllowlistEnabled(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VaultHarnessFactory.NotAllowlisted.selector, alice));
        sv.deposit(1e6, 0);
        vaultFactory.allow(alice, true);
        depositAs(alice, 1e6);
        uint256 principal = sv.principal();
        vaultFactory.setCap(principal + 5e6);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(VaultHarnessFactory.CapExceeded.selector, principal + 6e6, principal + 5e6)
        );
        sv.deposit(6e6, 0);
        vaultFactory.setCap(type(uint256).max);

        // The depeg guard (A-34) and a stale feed fail a deposit closed (MV-S11).
        usdcUsd.push(0.98e8);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.UsdcDepegged.selector, 0.98e18));
        sv.deposit(1e6, 0);
        usdcUsd.push(1e8);
        vaultBuys(address(tokA), 20e6);
        aUsd.setFailure(MockFeed.Failure.RevertRound);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(OracleAdapterV3.PriceUnavailable.selector, address(tokA), PriceReason.FEED_REVERTED)
        );
        sv.deposit(1e6, 0);
        aUsd.setFailure(MockFeed.Failure.None);
        depositAs(alice, 1e6);
    }

    /// Nobody deposits for a receiver, so nobody can extend another's lock (M-20).
    function test_ADepositOnlyEverLocksTheDepositor() public {
        seedAndOpen();
        depositAs(alice, 100e6);
        (uint256 lockedA, uint64 unlockA) = sv.lockOf(alice);
        warp(6 hours);
        depositAs(bob, 100e6);
        (uint256 lockedA2, uint64 unlockA2) = sv.lockOf(alice);
        assertEq(lockedA2, lockedA);
        assertEq(unlockA2, unlockA);
        (, uint64 unlockB) = sv.lockOf(bob);
        assertEq(unlockB, unlockA + 6 hours);
    }

    /// M-02: a deposit and an exit on either path never return more than went in.
    function test_NoRoundTripCreatesValue() public {
        threeDepositors();
        passLockup();
        uint256 sharesA = sv.sharesOf(alice);
        uint256 before = usdcBal(alice);
        uint256 out = redeemAs(alice, sharesA);
        assertEq(usdcBal(alice) - before, out);
        assertLt(out, 100e6, "the USDC path pays less than the deposit");
        uint256 beforeB = usdcBal(bob);
        redeemInKindAs(bob, sv.sharesOf(bob));
        assertLt(usdcBal(bob) - beforeB, 100e6, "the in-kind path pays less than the deposit");
        // What stayed is the spread, now the leader's alone.
        assertEq(sv.totalSupply(), sv.leaderShares());
        assertGt(sv.navUsdc(), 100e6);
    }

    function testFuzz_NoRoundTripCreatesValue(uint96 amount, uint8 others) public {
        amount = uint96(bound(amount, 1e6, 1_000e6));
        seedAndOpen();
        if (others % 2 == 1) depositAs(bob, 1 + uint256(others) * 3e6);
        uint256 shares = depositAs(alice, amount);
        passLockup();
        uint256 before = usdcBal(alice);
        if (others % 4 < 2) redeemAs(alice, shares);
        else redeemInKindAs(alice, shares);
        assertLe(usdcBal(alice) - before, amount);
    }

    /// M-03: inflating the price with a donation after a tiny seed cannot take
    /// a later depositor's value; the virtual shares price the deposit fairly or better.
    function test_InflationAttackFails() public {
        // The leader seeds one base unit and donates 10,000 USDC.
        depositAs(owner, 1);
        assertEq(sv.totalSupply(), 1e12);
        vm.prank(owner);
        sv.setDepositsOpen(true);
        usdc.mint(address(sv), 10_000e6);
        uint256 shares = depositAs(alice, 1e6);
        assertGt(shares, 0);
        passLockup();
        uint256 before = usdcBal(alice);
        redeemInKindAs(alice, shares);
        assertGe(usdcBal(alice) - before, 1e6 - 1, "the victim keeps the value put in");
        // The attacker gets back at most what they put in and gave.
        uint256 beforeOwner = usdcBal(owner);
        redeemInKindAs(owner, sv.sharesOf(owner));
        assertLe(usdcBal(owner) - beforeOwner, 10_000e6 + 1);
    }

    function testFuzz_InflationAttackFails(uint96 seed, uint96 donation, uint96 victim) public {
        seed = uint96(bound(seed, 1, 1e6));
        donation = uint96(bound(donation, 1, 100_000e6));
        depositAs(owner, seed);
        vm.prank(owner);
        sv.setDepositsOpen(true);
        usdc.mint(address(sv), donation);
        // The leader-stake rule bounds what a depositor may add after a tiny seed.
        uint256 max = sv.maxDeposit(alice);
        if (max < 2) return;
        victim = uint96(bound(victim, 1, max < 10_000e6 ? max : 10_000e6));
        uint256 shares = depositAs(alice, victim);
        passLockup();
        uint256 before = usdcBal(alice);
        redeemInKindAs(alice, shares);
        // The victim loses at most the 0.5% spread and one unit of rounding, never more to the inflation.
        uint256 victimOut = usdcBal(alice) - before;
        assertGe(victimOut + 1, uint256(victim) - Math.mulDiv(victim, 50, 10_000, Math.Rounding.Ceil));
        // Together they get back at most what went in: the attacker gains at most the spread.
        uint256 beforeOwner = usdcBal(owner);
        redeemInKindAs(owner, sv.sharesOf(owner));
        assertLe(usdcBal(owner) - beforeOwner + victimOut, uint256(seed) + donation + victim);
    }

    // =====================================================================
    // The leader stake (M-14 to M-17, MV-S9)
    // =====================================================================

    function test_ADepositThatWouldPushTheLeaderBelowFivePercentReverts() public {
        seedAndOpen();
        uint256 max = sv.maxDeposit(alice);
        // 20 times the stake in shares, less the supply, at the buy price: about 1,909.5 USDC.
        assertApproxEqAbs(max, 1_909.5e6, 1e6);
        vm.prank(alice);
        vm.expectPartialRevert(StrategyVaultV3.LeaderStakeTooLow.selector);
        sv.deposit(max + 2e6, 0);
        depositAs(alice, max);
        assertGe(sv.leaderStakeBps(), 500);
        assertLe(sv.maxDeposit(alice), 2e6);
        // The leader's own deposit restores room.
        depositAs(owner, 100e6);
        assertGt(sv.maxDeposit(alice), 1_000e6);
    }

    function test_TheLeaderCannotExitBelowFivePercent_OthersAreNeverBlocked() public {
        threeDepositors();
        passLockup();
        // 10 of 210 shares left would be 4.8%.
        vm.prank(owner);
        vm.expectPartialRevert(StrategyVaultV3.LeaderStakeTooLow.selector);
        sv.redeem(90e18, owner, 0, uint64(block.timestamp + 60));
        vm.prank(owner);
        vm.expectPartialRevert(StrategyVaultV3.LeaderStakeTooLow.selector);
        sv.redeemInKind(90e18, owner);
        // 20 of 220 is 9%.
        redeemAs(owner, 80e18);
        assertGe(sv.leaderStakeBps(), 500);
        // Depositors are never held by the rule.
        redeemAs(alice, sv.sharesOf(alice));
        redeemInKindAs(bob, sv.sharesOf(bob));
        assertEq(sv.totalSupply(), sv.leaderShares());
        // Alone, the leader may leave entirely.
        redeemInKindAs(owner, sv.sharesOf(owner));
        assertEq(sv.totalSupply(), 0);
    }

    /// `maxDeposit` answers zero for every refusal and never reverts (M-22).
    function test_MaxDepositNeverReverts() public {
        assertEq(sv.maxDeposit(alice), 0, "not open");
        assertEq(sv.maxDeposit(owner), type(uint256).max, "the leader");
        seedAndOpen();
        assertGt(sv.maxDeposit(alice), 0);
        vm.prank(sentinel);
        sv.closeDeposits();
        assertEq(sv.maxDeposit(alice), 0, "closed");
        vm.prank(owner);
        sv.openDeposits();
        vm.prank(sentinel);
        sv.pause();
        assertEq(sv.maxDeposit(alice), 0, "paused");
        warpDays(1);
        vm.prank(owner);
        sv.unpause();
        nft.setBroken(true);
        assertEq(sv.maxDeposit(alice), 0, "the agent unreadable");
        nft.setBroken(false);
        nft.setOwner(AGENT, buyer);
        assertEq(sv.maxDeposit(alice), 0, "handover");
        assertEq(sv.maxDeposit(buyer), 0, "the incoming owner uses the stake path");
        nft.setOwner(AGENT, owner);
        // The epoch moved twice: still a handover for the vault.
        assertTrue(sv.inHandover());
        assertEq(sv.maxDeposit(alice), 0);
    }

    // =====================================================================
    // Lockups (M-18 to M-23, MV-S4, MV-S10)
    // =====================================================================

    function test_BothExitPathsWaitForTheLockup() public {
        seedAndOpen();
        uint256 shares = depositAs(alice, 100e6);
        (, uint64 unlockAt) = sv.lockOf(alice);
        assertEq(sv.freeShares(alice), 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.SharesLocked.selector, 0, unlockAt));
        sv.redeem(1, alice, 0, uint64(block.timestamp + 60));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.SharesLocked.selector, 0, unlockAt));
        sv.redeemInKind(1, alice);
        warp(1 days - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.SharesLocked.selector, 0, unlockAt));
        sv.redeemInKind(1, alice);
        warp(1);
        assertEq(sv.freeShares(alice), shares);
        redeemAs(alice, shares / 2);
        redeemInKindAs(alice, sv.sharesOf(alice));
        assertEq(sv.sharesOf(alice), 0);
    }

    /// A self top-up joins the bucket and the unlock moves to the later time (D-072).
    function test_ATopUpJoinsTheBucketAndMovesTheUnlockLater() public {
        seedAndOpen();
        uint256 s1 = depositAs(alice, 100e6);
        uint64 t0 = uint64(block.timestamp);
        warp(12 hours);
        uint256 s2 = depositAs(alice, 50e6);
        (uint256 locked, uint64 unlockAt) = sv.lockOf(alice);
        assertEq(locked, s1 + s2);
        assertEq(unlockAt, t0 + 36 hours);
        assertEq(sv.freeShares(alice), 0);
        warp(12 hours + 1);
        assertEq(sv.freeShares(alice), 0, "the first deposit waits for the later unlock");
        warp(12 hours);
        assertEq(sv.freeShares(alice), s1 + s2);
    }

    function test_AnExpiredBucketStartsFresh() public {
        seedAndOpen();
        uint256 s1 = depositAs(alice, 100e6);
        passLockup();
        uint256 s2 = depositAs(alice, 50e6);
        (uint256 locked,) = sv.lockOf(alice);
        assertEq(locked, s2);
        assertEq(sv.freeShares(alice), s1);
        redeemAs(alice, s1);
        vm.prank(alice);
        vm.expectRevert();
        sv.redeem(1, alice, 0, uint64(block.timestamp + 60));
    }

    function test_LockupBounds_AndOnlyTheManager() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.BadLockup.selector, uint64(1 days - 1)));
        sv.setLockup(1 days - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.BadLockup.selector, uint64(7 days + 1)));
        sv.setLockup(7 days + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.NotManager.selector, alice));
        sv.setLockup(2 days);
        vm.prank(owner);
        sv.setLockup(7 days);
        (uint64 appliesAt,,, uint64 value) = sv.pendingLockup();
        assertEq(value, 7 days);
        assertEq(appliesAt, block.timestamp + 7 days + 2 days);
    }

    /// An increase waits the new duration plus the notice and applies to
    /// later deposits only; nothing applies early (MV-S4, M-21, D-076).
    function test_RaisingTheLockupWaitsAndAppliesToLaterDepositsOnly() public {
        seedAndOpen();
        vm.prank(owner);
        vm.expectEmit(address(sv));
        emit StrategyVaultV3.LockupProposed(3 days, uint64(block.timestamp + 5 days), uint64(block.timestamp + 12 days));
        sv.setLockup(3 days);
        assertEq(sv.lockup(), 1 days);
        uint256 s1 = depositAs(alice, 100e6);
        (, uint64 unlockA) = sv.lockOf(alice);
        assertEq(unlockA, block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.TooEarly.selector, uint64(block.timestamp + 5 days)));
        sv.applyLockup();
        warpDays(5);
        sv.applyLockup();
        assertEq(sv.lockup(), 3 days);
        (uint256 lockedA, uint64 unlockA2) = sv.lockOf(alice);
        assertEq(unlockA2, unlockA, "an existing lock never moves");
        assertEq(lockedA, s1);
        depositAs(bob, 100e6);
        (, uint64 unlockB) = sv.lockOf(bob);
        assertEq(unlockB, block.timestamp + 3 days);
        vm.expectRevert(StrategyVaultV3.NothingPending.selector);
        sv.applyLockup();
    }

    function test_LoweringTheLockupIsInstant_AndTouchesNoExistingLock() public {
        seedAndOpen();
        vm.prank(owner);
        sv.setLockup(2 days);
        warpDays(4);
        sv.applyLockup();
        depositAs(alice, 100e6);
        (, uint64 unlockA) = sv.lockOf(alice);
        assertEq(unlockA, block.timestamp + 2 days);
        vm.prank(owner);
        vm.expectEmit(address(sv));
        emit StrategyVaultV3.LockupSet(2 days, 1 days);
        sv.setLockup(1 days);
        assertEq(sv.lockup(), 1 days);
        (, uint64 unlockA2) = sv.lockOf(alice);
        assertEq(unlockA2, unlockA);
        depositAs(bob, 100e6);
        (, uint64 unlockB) = sv.lockOf(bob);
        assertEq(unlockB, block.timestamp + 1 days);
        // Lowering drops a pending increase.
        vm.prank(owner);
        sv.setLockup(5 days);
        vm.prank(owner);
        sv.setLockup(1 days);
        (uint64 appliesAt,,,) = sv.pendingLockup();
        assertEq(appliesAt, 0);
    }

    function test_APendingIncreaseLapses_AndFailsAfterASale() public {
        vm.prank(owner);
        sv.setLockup(2 days);
        warp(4 days + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.Lapsed.selector, uint64(block.timestamp - 1)));
        sv.applyLockup();
        vm.prank(owner);
        sv.setLockup(2 days);
        uint64 epoch = nft.ownerEpoch(AGENT);
        nft.setOwner(AGENT, buyer);
        warpDays(4);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.StaleProposal.selector, epoch, epoch + 1));
        sv.applyLockup();
    }

    function test_TheManagerOrTheGuardianCancelsAPendingIncrease() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.NotManagerOrGuardian.selector, alice));
        sv.cancelLockupProposal();
        vm.prank(guardian);
        vm.expectRevert(StrategyVaultV3.NothingPending.selector);
        sv.cancelLockupProposal();
        vm.prank(owner);
        sv.setLockup(3 days);
        vm.prank(guardian);
        sv.cancelLockupProposal();
        (uint64 appliesAt,,,) = sv.pendingLockup();
        assertEq(appliesAt, 0);
        vm.prank(owner);
        sv.setLockup(3 days);
        vm.prank(owner);
        sv.cancelLockupProposal();
        warpDays(6);
        vm.expectRevert(StrategyVaultV3.NothingPending.selector);
        sv.applyLockup();
    }

    /// Locks are waived in a pause, in wind-down and in handover (M-23, D-075).
    function test_LocksAreWaivedInAPause() public {
        seedAndOpen();
        uint256 shares = depositAs(alice, 100e6);
        assertEq(sv.freeShares(alice), 0);
        vm.prank(sentinel);
        sv.pause();
        assertEq(sv.freeShares(alice), shares);
        redeemInKindAs(alice, shares / 2);
        redeemAs(alice, sv.sharesOf(alice));
        assertEq(sv.sharesOf(alice), 0);
    }

    function test_LocksAreWaivedInWindDown() public {
        seedAndOpen();
        uint256 shares = depositAs(alice, 100e6);
        vm.prank(owner);
        sv.closeVault();
        assertEq(sv.freeShares(alice), shares);
        redeemAs(alice, shares);
    }

    function test_LocksAreWaivedInHandover() public {
        seedAndOpen();
        uint256 shares = depositAs(alice, 100e6);
        nft.setOwner(AGENT, buyer);
        assertEq(sv.freeShares(alice), shares);
        redeemAs(alice, shares / 2);
        redeemInKindAs(alice, sv.sharesOf(alice));
        // The old leader's stake is free too.
        assertEq(sv.freeShares(owner), sv.sharesOf(owner));
        redeemInKindAs(owner, sv.sharesOf(owner));
        assertEq(sv.totalSupply(), 0);
    }

    // =====================================================================
    // The USDC path (M-07, M-08, M-11, MV-S12, MV-S14)
    // =====================================================================

    function test_TheUsdcPathPaysTheValueLessTheSpread() public {
        threeDepositors();
        passLockup();
        uint256 shares = sv.sharesOf(alice);
        uint256 supply = sv.totalSupply();
        uint256 nav = sv.navUsdc();
        uint256 navSell = nav - Math.mulDiv(nav, 50, 10_000, Math.Rounding.Ceil);
        uint256 expected = Math.mulDiv(shares, navSell, supply);
        assertEq(sv.convertToAssets(shares), expected);
        uint256 before = usdcBal(alice);
        vm.prank(alice);
        vm.expectEmit(address(sv));
        emit StrategyVaultV3.Redeemed(alice, alice, shares, expected, 0);
        uint256 out = sv.redeem(shares, alice, expected, uint64(block.timestamp + 60));
        assertEq(out, expected);
        assertEq(usdcBal(alice) - before, expected);
        assertEq(sv.sharesOf(alice), 0);
        assertEq(sv.totalSupply(), supply - shares);
        assertEq(sv.principal(), 300e6 - expected);
        assertEq(vaultFactory.platformTotal(), 300e6 - expected);
    }

    /// When USDC above the 10% floor does not cover an exit, the call names
    /// the in-kind path instead of selling anything (as built in P7-U1).
    function test_TheUsdcPathNamesTheInKindPathWhenUsdcDoesNotCover() public {
        threeDepositors();
        vaultBuys(address(tokA), 120e6);
        vaultBuys(address(tokB), 120e6);
        assertEq(usdcBal(address(sv)), 60e6);
        passLockup();
        uint256 shares = sv.sharesOf(alice);
        uint256 owed = sv.convertToAssets(shares);
        uint256 floor = Math.mulDiv(300e6 - owed, 1_000, 10_000, Math.Rounding.Ceil);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.UseInKind.selector, owed, 60e6 - floor));
        sv.redeem(shares, alice, 0, uint64(block.timestamp + 60));
        // A small exit still pays in USDC: 20 owed, 280 left, floor 28, 48 of 60 needed.
        uint256 small = Math.mulDiv(shares, 20e6, owed);
        uint256 out = redeemAs(alice, small);
        assertApproxEqAbs(out, 20e6, 1e4);
        // A larger one does not: 35 owed, 265 left, floor 26.5, 61.5 of 40 left.
        uint256 larger = Math.mulDiv(shares, 35e6, owed);
        vm.prank(alice);
        vm.expectRevert();
        sv.redeem(larger, alice, 0, uint64(block.timestamp + 60));
        // In kind, the rest comes out across every token.
        uint256 rest = sv.sharesOf(alice);
        uint256 supply = sv.totalSupply();
        redeemInKindAs(alice, rest);
        assertEq(tokA.balanceOf(alice), Math.mulDiv(20e18, rest, supply));
        assertEq(tokB.balanceOf(alice), Math.mulDiv(3e8, rest, supply));
    }

    function test_MinAssetsOutAndTheDeadline() public {
        threeDepositors();
        passLockup();
        uint256 shares = sv.sharesOf(alice);
        uint256 owed = sv.convertToAssets(shares);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.AssetsTooFew.selector, owed, owed + 1));
        sv.redeem(shares, alice, owed + 1, uint64(block.timestamp + 60));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.Expired.selector, uint64(block.timestamp - 1)));
        sv.redeem(shares, alice, 0, uint64(block.timestamp - 1));
        vm.prank(alice);
        vm.expectRevert(CustodyCoreV3.ZeroAmount.selector);
        sv.redeem(0, alice, 0, uint64(block.timestamp + 60));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.BadRecipient.selector, address(sv)));
        sv.redeem(shares, address(sv), 0, uint64(block.timestamp + 60));
    }

    /// Only the share owner burns their shares, to any receiver they name (MV-S14).
    function test_OnlyTheShareOwnerBurnsTheirShares_ToAnyReceiver() public {
        threeDepositors();
        passLockup();
        uint256 shares = sv.sharesOf(alice);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.InsufficientShares.selector, 0, shares));
        sv.redeem(shares, stranger, 0, uint64(block.timestamp + 60));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.InsufficientShares.selector, 0, shares));
        sv.redeemInKind(shares, stranger);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.InsufficientShares.selector, shares, shares + 1));
        sv.redeem(shares + 1, alice, 0, uint64(block.timestamp + 60));
        vm.prank(alice);
        uint256 out = sv.redeem(shares / 2, sink, 0, uint64(block.timestamp + 60));
        assertEq(usdcBal(sink), out);
        uint256 rest = sv.sharesOf(alice);
        vm.prank(alice);
        sv.redeemInKind(rest, sink);
        assertGt(usdcBal(sink), out);
    }

    // =====================================================================
    // The in-kind path (M-12, MV-S1, M-25, M-26)
    // =====================================================================

    /// Each slice is the floor of the pro-rata share; everyone else's claims never fall (M-12).
    function test_InKindPaysTheFloorOfEachSlice_AndOthersClaimsNeverFall() public {
        threeDepositors();
        vaultBuys(address(tokA), 90e6);
        vaultBuys(address(tokB), 90e6);
        passLockup();
        uint256 shares = sv.sharesOf(alice);
        uint256 supply = sv.totalSupply();
        (address[] memory toks, uint256[] memory preview) = sv.inKindAmounts(shares);
        assertEq(toks.length, 3);
        (, uint256[] memory bobBefore) = sv.inKindAmounts(sv.sharesOf(bob));
        uint256[3] memory bal = [usdcBal(address(sv)), tokA.balanceOf(address(sv)), tokB.balanceOf(address(sv))];
        vm.prank(alice);
        vm.expectEmit(address(sv));
        emit StrategyVaultV3.RedeemedInKind(alice, alice, shares, supply);
        sv.redeemInKind(shares, alice);
        assertEq(usdcBal(alice) - (1_000_000e6 - 100e6), Math.mulDiv(bal[0], shares, supply));
        assertEq(tokA.balanceOf(alice), Math.mulDiv(bal[1], shares, supply));
        assertEq(tokB.balanceOf(alice), Math.mulDiv(bal[2], shares, supply));
        assertEq(preview[0], Math.mulDiv(bal[0], shares, supply));
        assertEq(preview[1], tokA.balanceOf(alice));
        assertEq(preview[2], tokB.balanceOf(alice));
        (, uint256[] memory bobAfter) = sv.inKindAmounts(sv.sharesOf(bob));
        for (uint256 i = 0; i < 3; ++i) {
            assertGe(bobAfter[i], bobBefore[i], "another holder's claim fell");
        }
        assertEq(sv.totalSupply(), supply - shares);
        assertEq(sv.principal(), 300e6 - Math.mulDiv(300e6, shares, supply));
    }

    function testFuzz_InKindIsProRata_AndNeverOverpays(uint96 a, uint96 b, uint96 part) public {
        a = uint96(bound(a, 1e6, 900e6));
        b = uint96(bound(b, 1e6, 900e6));
        seedAndOpen();
        uint256 sharesA = depositAs(alice, a);
        depositAs(bob, b);
        vaultBuys(address(tokA), sv.navUsdc() * 3 / 10);
        passLockup();
        uint256 shares = bound(part, 1, sharesA);
        uint256 supply = sv.totalSupply();
        uint256 usdcHeld = usdcBal(address(sv));
        uint256 aHeld = tokA.balanceOf(address(sv));
        uint256 before = usdcBal(alice);
        redeemInKindAs(alice, shares);
        assertEq(usdcBal(alice) - before, Math.mulDiv(usdcHeld, shares, supply));
        assertEq(tokA.balanceOf(alice), Math.mulDiv(aHeld, shares, supply));
        assertEq(sv.sharesOf(alice), sharesA - shares);
    }

    /// MV-S1: a token that refuses the transfer becomes the exiter's credit;
    /// the other tokens come out, nobody else is touched, and the credit is
    /// claimed later to any address.
    function test_ARevertingTokenBecomesACredit_AndTheOthersComeOut() public {
        threeDepositors();
        vaultBuys(address(tokA), 90e6);
        vaultBuys(address(tokB), 90e6);
        passLockup();
        uint256 shares = sv.sharesOf(alice);
        uint256 supply = sv.totalSupply();
        uint256 aHeld = tokA.balanceOf(address(sv));
        uint256 slice = Math.mulDiv(aHeld, shares, supply);
        tokA.setBlocked(address(sv), true);
        vm.prank(alice);
        vm.expectEmit(address(sv));
        emit StrategyVaultV3.InKindSkipped(address(tokA), alice, slice);
        sv.redeemInKind(shares, alice);
        assertEq(tokA.balanceOf(alice), 0);
        assertGt(tokB.balanceOf(alice), 0);
        assertEq(sv.claimable(address(tokA), alice), slice);
        assertEq(sv.totalClaimable(address(tokA)), slice);
        assertEq(sv.freeBalance(address(tokA)), aHeld - slice);
        assertEq(tokA.balanceOf(address(sv)), aHeld);
        // Bob's slice is of the free balance: the credit is out of his math.
        uint256 bobShares = sv.sharesOf(bob);
        uint256 bobSlice = Math.mulDiv(aHeld - slice, bobShares, sv.totalSupply());
        (, uint256[] memory preview) = sv.inKindAmounts(bobShares);
        assertEq(preview[1], bobSlice);
        // NAV leaves the credit out.
        assertEq(
            sv.navUsdc(), usdcBal(address(sv)) + (aHeld - slice) * 6 / 1e12 + tokB.balanceOf(address(sv)) * 40 / 1e2
        );
        // Still refused: the credit stays.
        vm.prank(alice);
        vm.expectRevert();
        sv.claim(address(tokA), sink);
        tokA.setBlocked(address(sv), false);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NothingToClaim.selector, address(tokA)));
        sv.claim(address(tokA), bob);
        vm.prank(alice);
        sv.claim(address(tokA), sink);
        assertEq(tokA.balanceOf(sink), slice);
        assertEq(sv.claimable(address(tokA), alice), 0);
        assertEq(sv.totalClaimable(address(tokA)), 0);
        redeemInKindAs(bob, bobShares);
        assertEq(tokA.balanceOf(bob), bobSlice);
    }

    /// M-25, M-26 and the offline exit in one: with the oracle, the registry,
    /// the factory, the Executor and AgentNFT all reverting and the vault
    /// paused, every depositor still leaves in kind with their exact slices.
    function test_InKindWorksWithEveryOtherContractBroken() public {
        threeDepositors();
        vaultBuys(address(tokA), 90e6);
        vaultBuys(address(tokB), 90e6);
        vm.prank(guardian);
        sv.pause();
        uint256 supply = sv.totalSupply();
        uint256[3] memory bal = [usdcBal(address(sv)), tokA.balanceOf(address(sv)), tokB.balanceOf(address(sv))];
        bytes memory dead = address(new RevertingLedger()).code;
        vm.etch(address(oracle), dead);
        vm.etch(address(tokens), dead);
        vm.etch(address(vaultFactory), dead);
        vm.etch(address(nft), dead);
        vm.etch(address(executor), dead);
        vm.expectRevert();
        sv.navUsdc();
        vm.prank(alice);
        vm.expectRevert();
        sv.redeem(1, alice, 0, uint64(block.timestamp + 60));
        uint256 sharesA = sv.sharesOf(alice);
        redeemInKindAs(alice, sharesA);
        assertEq(tokA.balanceOf(alice), Math.mulDiv(bal[1], sharesA, supply));
        assertEq(tokB.balanceOf(alice), Math.mulDiv(bal[2], sharesA, supply));
        assertEq(usdcBal(alice), 1_000_000e6 - 100e6 + Math.mulDiv(bal[0], sharesA, supply));
        redeemInKindAs(bob, sv.sharesOf(bob));
        redeemInKindAs(owner, sv.sharesOf(owner));
        assertEq(sv.totalSupply(), 0);
        assertEq(tokA.balanceOf(address(sv)), 0);
        assertEq(tokB.balanceOf(address(sv)), 0);
        assertEq(usdcBal(address(sv)), 0);
        assertEq(sv.heldCount(), 1, "the emptied tokens left the list");
    }

    function test_InKindNeedsNoFeed() public {
        threeDepositors();
        vaultBuys(address(tokA), 60e6);
        passLockup();
        aUsd.setFailure(MockFeed.Failure.RevertRound);
        monUsd.setFailure(MockFeed.Failure.RevertDecimals);
        vm.prank(alice);
        vm.expectRevert();
        sv.redeem(1, alice, 0, uint64(block.timestamp + 60));
        redeemInKindAs(alice, sv.sharesOf(alice));
        assertGt(tokA.balanceOf(alice), 0);
    }

    /// Hostile held tokens: one that burns its gas, one that answers with a
    /// return bomb, one whose balance read reverts. None stops the exit.
    function test_HostileTokensCannotBlockTheInKindExit() public {
        GasBurningToken burner = new GasBurningToken();
        ReturnBombToken bomb = new ReturnBombToken();
        BalanceRevertingToken blind = new BalanceRevertingToken();
        registerCore(burner);
        registerCore(bomb);
        registerCore(blind);
        threeDepositors();
        vaultBuys(address(burner), 30e6);
        vaultBuys(address(bomb), 30e6);
        vaultBuys(address(blind), 30e6);
        vaultBuys(address(tokA), 30e6);
        passLockup();
        burner.arm(true);
        bomb.armTransfer(true);
        blind.arm(true);
        uint256 shares = sv.sharesOf(alice);
        uint256 supply = sv.totalSupply();
        uint256 aSlice = Math.mulDiv(tokA.balanceOf(address(sv)), shares, supply);
        redeemInKindAs(alice, shares);
        assertEq(tokA.balanceOf(alice), aSlice, "the honest token came out");
        assertGt(usdcBal(alice), 1_000_000e6 - 100e6);
        assertEq(sv.claimable(address(burner), alice), Math.mulDiv(30e18, shares, supply));
        assertEq(sv.claimable(address(bomb), alice), Math.mulDiv(30e18, shares, supply));
        assertEq(sv.claimable(address(blind), alice), 0, "an unreadable balance is skipped, not credited");
        burner.arm(false);
        bomb.armTransfer(false);
        blind.arm(false);
        vm.startPrank(alice);
        sv.claim(address(burner), alice);
        sv.claim(address(bomb), alice);
        vm.stopPrank();
        assertEq(burner.balanceOf(alice), Math.mulDiv(30e18, shares, supply));
        // The skipped token is still in the vault for everyone, Alice's shares gone.
        assertEq(blind.balanceOf(address(sv)), 30e18);
    }

    function test_NobodyWithdrawsDirectly_NotEvenTheManager() public {
        threeDepositors();
        address[3] memory callers = [owner, guardian, alice];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, callers[i]));
            sv.withdraw(address(usdc), 1, callers[i]);
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, callers[i]));
            sv.withdrawAll(callers[i]);
        }
    }
}
