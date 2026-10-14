// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {StrategyVaultV3} from "../../src/fund/StrategyVaultV3.sol";
import {AccountMode} from "../../src/interfaces/ICustody.sol";
import {SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
import {StrategyVaultV3Base} from "./StrategyVaultV3Base.sol";

/// The vault's modes (P7-U1): handover on an agent sale (FINAL_PLAN 4.7.7),
/// wind-down (4.7.6, D-242), the pause and the breaker on the share price
/// (4.7.8, D-080, M-25 to M-27), the reference band (MV-S8), the dormant fee
/// (MV-V19), the trading hooks (class F only, epochs, handover) and the
/// tighten-only roles.
contract StrategyVaultV3ModesTest is StrategyVaultV3Base {
    address internal buyer2 = makeAddr("buyer2");

    function setUp() public override {
        super.setUp();
        usdc.mint(buyer2, 100_000e6);
        vm.prank(buyer2);
        usdc.approve(address(sv), type(uint256).max);
    }

    function buyParams(uint256 usdcIn) internal view returns (SwapParamsV3 memory) {
        return params(address(usdc), address(tokA), usdcIn);
    }

    function stakeAs(address who, uint256 assets) internal returns (uint256) {
        vm.prank(who);
        return sv.stakeAsIncomingLeader(assets, 0);
    }

    // =====================================================================
    // Handover on an agent sale (FINAL_PLAN 4.7.7, M-24 on the vault's side)
    // =====================================================================

    function test_ASaleStartsAHandover() public {
        threeDepositors();
        vaultBuys(address(tokA), 60e6);
        uint64 epoch = nft.ownerEpoch(AGENT);
        SwapParamsV3 memory buy = buyParams(10e6);
        nft.setOwner(AGENT, buyer);
        assertTrue(sv.inHandover());
        assertEq(sv.manager(), address(0));
        assertEq(uint8(sv.effectiveMode()), uint8(AccountMode.HANDOVER));
        assertEq(uint8(sv.mode()), uint8(AccountMode.NORMAL), "the stored mode is the core's");
        // Deposits close, for the buyer too; the old owner is powerless.
        vm.prank(alice);
        vm.expectRevert(StrategyVaultV3.InHandover.selector);
        sv.deposit(1e6, 0);
        vm.prank(buyer);
        vm.expectRevert(StrategyVaultV3.InHandover.selector);
        sv.deposit(1e6, 0);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.NotManager.selector, owner));
        sv.setDepositsOpen(false);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.NotManager.selector, owner));
        sv.setLockup(2 days);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.NotManager.selector, owner));
        sv.closeVault();
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, owner));
        sv.unpause();
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotTightener.selector, owner));
        sv.pause();
        vm.stopPrank();
        // Trading goes on, into USDC only, under the new epoch.
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.StaleEpoch.selector, epoch, epoch + 1));
        executor.swap(sv, buy);
        buy.ownershipEpoch = epoch + 1;
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.ReduceOnly.selector, AccountMode.HANDOVER));
        executor.swap(sv, buy);
        vaultSells(address(tokA), 1e18);
        // Every holder may leave, the old leader included, locks waived.
        assertEq(sv.freeShares(alice), sv.sharesOf(alice));
        redeemInKindAs(alice, sv.sharesOf(alice));
        redeemInKindAs(owner, sv.sharesOf(owner));
        assertEq(sv.sharesOf(owner), 0);
        assertEq(sv.leaderShares(), 0);
    }

    function test_TheIncomingOwnerStakesAndAcceptsAfterTheHandoverPeriod() public {
        threeDepositors();
        nft.setOwner(AGENT, buyer);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.NotAgentOwner.selector, buyer));
        sv.stakeAsIncomingLeader(50e6, 0);
        vm.prank(buyer);
        vm.expectEmit(true, false, false, false, address(sv));
        emit StrategyVaultV3.HandoverStaked(buyer, 50e6, 0);
        uint256 stake = sv.stakeAsIncomingLeader(50e6, 0);
        assertEq(sv.incomingLeader(), buyer);
        assertEq(sv.incomingShares(), stake);
        assertEq(sv.sharesOf(buyer), stake);
        assertEq(sv.balanceOf(buyer), 0);
        assertEq(sv.leader(), owner, "the old leader until acceptance");
        uint64 since = uint64(block.timestamp);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.HandoverTooRecent.selector, since + 3 days));
        sv.acceptManagement();
        warpDays(3);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.NotAgentOwner.selector, buyer));
        sv.acceptManagement();
        uint256 oldStake = sv.leaderShares();
        uint64 newEpoch = nft.ownerEpoch(AGENT);
        vm.prank(buyer);
        vm.expectEmit(address(sv));
        emit StrategyVaultV3.ManagementAccepted(owner, buyer, newEpoch);
        sv.acceptManagement();
        assertFalse(sv.inHandover());
        assertEq(sv.manager(), buyer);
        assertEq(sv.leader(), buyer);
        assertEq(sv.leaderShares(), stake);
        assertEq(sv.incomingLeader(), address(0));
        assertEq(sv.incomingShares(), 0);
        assertEq(sv.acceptedEpoch(), nft.ownerEpoch(AGENT));
        assertFalse(sv.depositsOpen(), "deposits stay closed until the new manager opens them");
        // The old leader's stake is ordinary and unlocked.
        assertEq(sv.balanceOf(owner), oldStake);
        assertEq(sv.sharesOf(owner), oldStake);
        (uint256 locked, uint64 unlockAt) = sv.lockOf(owner);
        assertEq(locked, 0);
        assertEq(unlockAt, 0);
        assertEq(sv.freeShares(owner), oldStake);
        redeemAs(owner, oldStake);
        // The new manager runs the vault.
        vm.prank(buyer);
        sv.setDepositsOpen(true);
        depositAs(alice, 10e6);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.NotManager.selector, owner));
        sv.setDepositsOpen(false);
    }

    function test_AcceptanceNeedsAStakeOfFivePercent() public {
        threeDepositors();
        nft.setOwner(AGENT, buyer);
        warpDays(3);
        uint256 supply = sv.totalSupply();
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.LeaderStakeTooLow.selector, 0, supply));
        sv.acceptManagement();
        // 10 of about 310 is 3.2%.
        uint256 small = stakeAs(buyer, 10e6);
        supply = sv.totalSupply();
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.LeaderStakeTooLow.selector, small, supply));
        sv.acceptManagement();
        stakeAs(buyer, 10e6);
        vm.prank(buyer);
        sv.acceptManagement();
        assertEq(sv.leader(), buyer);
        assertGe(sv.leaderStakeBps(), 500);
    }

    function test_ASecondSaleDuringAHandoverReleasesTheFirstIncomingStake() public {
        threeDepositors();
        nft.setOwner(AGENT, buyer);
        uint256 first = stakeAs(buyer, 50e6);
        nft.setOwner(AGENT, buyer2);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.NotAgentOwner.selector, buyer2));
        sv.stakeAsIncomingLeader(1e6, 0);
        vm.prank(buyer2);
        vm.expectEmit(address(sv));
        emit StrategyVaultV3.IncomingStakeReleased(buyer, first);
        uint256 second = sv.stakeAsIncomingLeader(50e6, 0);
        assertEq(sv.incomingLeader(), buyer2);
        assertEq(sv.incomingShares(), second);
        assertEq(sv.balanceOf(buyer), first, "the first buyer's stake became ordinary shares");
        assertEq(sv.freeShares(buyer), first, "waived in the handover");
        warpDays(3);
        vm.prank(buyer2);
        sv.acceptManagement();
        assertEq(sv.leader(), buyer2);
        redeemInKindAs(buyer, first);
    }

    /// The incoming stake is exempt from closed deposits and from a pause's
    /// deposit block, since a handover could not end otherwise; nobody else is.
    function test_TheIncomingStakeIsExemptFromClosedDepositsAndAPause() public {
        threeDepositors();
        nft.setOwner(AGENT, buyer);
        vm.startPrank(sentinel);
        sv.closeDeposits();
        sv.pause();
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(StrategyVaultV3.InHandover.selector);
        sv.deposit(1e6, 0);
        uint256 stake = stakeAs(buyer, 50e6);
        assertEq(sv.incomingShares(), stake);
        warpDays(3);
        vm.prank(buyer);
        sv.acceptManagement();
        // The new manager unpauses after the lockup since the pause, then reopens.
        vm.prank(buyer);
        sv.unpause();
        vm.prank(buyer);
        sv.openDeposits();
        vm.prank(buyer);
        sv.setDepositsOpen(true);
        depositAs(alice, 1e6);
    }

    /// The incoming stake is locked like any other deposit (FINAL_PLAN 4.7.7).
    function test_TheIncomingStakeIsLockedLikeAnyOther() public {
        vm.prank(owner);
        sv.setLockup(7 days);
        warpDays(9);
        sv.applyLockup();
        threeDepositors();
        nft.setOwner(AGENT, buyer);
        uint256 stake = stakeAs(buyer, 50e6);
        (uint256 locked, uint64 unlockAt) = sv.lockOf(buyer);
        assertEq(locked, stake);
        assertEq(unlockAt, block.timestamp + 7 days);
        warpDays(3);
        vm.prank(buyer);
        sv.acceptManagement();
        assertEq(sv.freeShares(buyer), 0, "the handover's waiver ended with it");
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.SharesLocked.selector, 0, unlockAt));
        sv.redeemInKind(1, buyer);
        warpDays(4);
        assertEq(sv.freeShares(buyer), stake);
    }

    /// The incoming owner who never accepts leaves like anyone else: the stake
    /// burns from `incomingShares` (found by the P7-U3 invariant run, L-224).
    function test_TheIncomingOwnerCanLeaveWithoutAccepting() public {
        threeDepositors();
        nft.setOwner(AGENT, buyer);
        uint256 stake = stakeAs(buyer, 50e6);
        assertEq(sv.incomingShares(), stake);
        assertEq(sv.sharesOf(buyer), stake);
        // Half in kind, the rest in USDC; locks are waived in the handover.
        vm.prank(buyer);
        sv.redeemInKind(stake / 2, buyer);
        assertEq(sv.incomingShares(), stake - stake / 2);
        uint256 before = usdcBal(buyer);
        redeemAs(buyer, sv.sharesOf(buyer));
        assertGt(usdcBal(buyer), before);
        assertEq(sv.incomingShares(), 0);
        assertEq(sv.sharesOf(buyer), 0);
        assertEq(sv.incomingLeader(), buyer, "the slot stays until another stake or acceptance");
        // With no stake left, acceptance is refused; a new stake works.
        warpDays(3);
        vm.prank(buyer);
        vm.expectPartialRevert(StrategyVaultV3.LeaderStakeTooLow.selector);
        sv.acceptManagement();
        stakeAs(buyer, 50e6);
        vm.prank(buyer);
        sv.acceptManagement();
        assertEq(sv.leader(), buyer);
    }

    function test_AnAgentSoldAndBoughtBackIsStillInHandover_UntilAccepted() public {
        threeDepositors();
        nft.setOwner(AGENT, buyer);
        nft.setOwner(AGENT, owner);
        assertTrue(sv.inHandover());
        assertEq(sv.manager(), address(0));
        uint256 stake = stakeAs(owner, 20e6);
        warpDays(3);
        vm.prank(owner);
        sv.acceptManagement();
        assertEq(sv.leader(), owner);
        // The former stake became ordinary shares; the new stake is the leader's.
        assertEq(sv.leaderShares(), stake);
        assertEq(sv.balanceOf(owner), 100e18);
        assertEq(sv.manager(), owner);
    }

    // =====================================================================
    // Wind-down (FINAL_PLAN 4.7.6, D-242)
    // =====================================================================

    function test_CloseVaultWindsDown() public {
        threeDepositors();
        vaultBuys(address(tokA), 60e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.NotManager.selector, alice));
        sv.closeVault();
        vm.prank(owner);
        vm.expectEmit(address(sv));
        emit StrategyVaultV3.VaultClosed(AGENT, owner, uint64(block.timestamp));
        sv.closeVault();
        assertEq(sv.windDownAt(), block.timestamp);
        assertVaultMode(AccountMode.WIND_DOWN);
        assertEq(uint8(sv.effectiveMode()), uint8(AccountMode.WIND_DOWN));
        assertFalse(sv.depositsOpen());
        vm.prank(alice);
        vm.expectRevert(StrategyVaultV3.DepositsNotOpen.selector);
        sv.deposit(1e6, 0);
        vm.prank(owner);
        vm.expectRevert(StrategyVaultV3.WindingDown.selector);
        sv.deposit(1e6, 0);
        vm.prank(owner);
        vm.expectRevert(StrategyVaultV3.WindingDown.selector);
        sv.setDepositsOpen(true);
        vm.prank(owner);
        vm.expectRevert(StrategyVaultV3.WindingDown.selector);
        sv.closeVault();
        assertEq(sv.maxDeposit(alice), 0);
        // Reduce-only trading.
        SwapParamsV3 memory buy = buyParams(10e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.ReduceOnly.selector, AccountMode.WIND_DOWN));
        executor.swap(sv, buy);
        vaultSells(address(tokA), 1e18);
        // Locks waived; the leader waits the longest lockup before leaving last.
        assertEq(sv.freeShares(alice), sv.sharesOf(alice));
        redeemInKindAs(alice, sv.sharesOf(alice));
        vm.prank(owner);
        vm.expectPartialRevert(StrategyVaultV3.LeaderStakeTooLow.selector);
        sv.redeemInKind(100e18, owner);
        warpDays(7);
        redeemInKindAs(owner, 100e18);
        assertEq(sv.leaderShares(), 0);
        redeemInKindAs(bob, sv.sharesOf(bob));
        assertEq(sv.totalSupply(), 0);
    }

    function test_WindDownSurvivesAPauseAndAnUnpause() public {
        threeDepositors();
        vm.prank(owner);
        sv.closeVault();
        vm.prank(sentinel);
        sv.pause();
        assertVaultMode(AccountMode.PAUSED);
        warpDays(1);
        vm.prank(owner);
        sv.unpause();
        assertVaultMode(AccountMode.WIND_DOWN);
        vm.prank(sentinel);
        sv.setReduceOnly();
        assertVaultMode(AccountMode.WIND_DOWN);
    }

    // =====================================================================
    // Pause, reduce-only and the breaker (FINAL_PLAN 4.7.8, D-080)
    // =====================================================================

    function test_ThePauseBlocksDepositsAndNewRisk_NeverExits() public {
        threeDepositors();
        vaultBuys(address(tokA), 60e6);
        vm.prank(guardian);
        sv.pause();
        assertEq(sv.pausedAt(), block.timestamp);
        vm.prank(alice);
        vm.expectRevert(StrategyVaultV3.DepositsPaused.selector);
        sv.deposit(1e6, 0);
        SwapParamsV3 memory buy = buyParams(10e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.ReduceOnly.selector, AccountMode.PAUSED));
        executor.swap(sv, buy);
        vaultSells(address(tokA), 1e18);
        assertEq(sv.freeShares(alice), sv.sharesOf(alice));
        redeemAs(alice, sv.sharesOf(alice) / 2);
        redeemInKindAs(alice, sv.sharesOf(alice));
    }

    function test_UnpauseWaitsOneLockup_AndOnlyTheManager() public {
        threeDepositors();
        vm.prank(sentinel);
        sv.pause();
        uint64 unpausableAt = uint64(block.timestamp) + 1 days;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.PauseTooRecent.selector, unpausableAt));
        sv.unpause();
        warp(1 days - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.PauseTooRecent.selector, unpausableAt));
        sv.unpause();
        warp(1);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, guardian));
        sv.unpause();
        vm.prank(sentinel);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, sentinel));
        sv.unpause();
        vm.prank(owner);
        sv.unpause();
        assertVaultMode(AccountMode.NORMAL);
        depositAs(alice, 1e6);
        // Reduce-only lifts at once: no pause began.
        vm.prank(sentinel);
        sv.setReduceOnly();
        vm.prank(owner);
        sv.unpause();
        assertVaultMode(AccountMode.NORMAL);
    }

    /// The wait follows the lockup in force: a longer lockup means a longer wait.
    function test_TheUnpauseWaitFollowsTheLockup() public {
        vm.prank(owner);
        sv.setLockup(3 days);
        warpDays(5);
        sv.applyLockup();
        depositAs(owner, SEED);
        vm.prank(guardian);
        sv.pause();
        warpDays(2);
        vm.prank(owner);
        vm.expectPartialRevert(StrategyVaultV3.PauseTooRecent.selector);
        sv.unpause();
        warpDays(1);
        vm.prank(owner);
        sv.unpause();
    }

    /// The breaker watches the share price: 10% below the 7-day peak sets
    /// reduce-only, 20% pauses; deposits and exits never move the price.
    function test_TheBreakerTripsOnTheSharePrice() public {
        depositAs(owner, SEED);
        vaultBuys(address(tokA), 40e6);
        (, uint256 perUnit, uint256 peak,) = sv.breakerState();
        assertApproxEqRel(perUnit, 1e18, 1e12);
        assertEq(peak, perUnit);
        setA(5.4e8); // A down 10%: NAV 96, the price 4% below the peak
        sv.poke();
        assertVaultMode(AccountMode.NORMAL);
        setA(4.4e8); // A down 27%: NAV 89.3, 10.7% below
        sv.poke();
        assertVaultMode(AccountMode.REDUCE_ONLY);
        (,,, uint256 dd1) = sv.breakerState();
        assertGe(dd1, 1_000);
        assertLt(dd1, 2_000);
        vm.prank(owner);
        sv.setDepositsOpen(true);
        depositAs(alice, 10e6);
        setA(2.6e8); // A down 57%: with Alice's USDC in, 21% below the peak
        sv.poke();
        assertVaultMode(AccountMode.PAUSED);
        (,,, uint256 dd2) = sv.breakerState();
        assertGe(dd2, 2_000);
        vm.prank(alice);
        vm.expectRevert(StrategyVaultV3.DepositsPaused.selector);
        sv.deposit(1e6, 0);
        redeemInKindAs(alice, sv.sharesOf(alice));
        warpDays(1);
        vm.prank(owner);
        sv.unpause();
        assertVaultMode(AccountMode.NORMAL);
        (, uint256 perUnitAfter, uint256 peakAfter, uint256 dd) = sv.breakerState();
        assertEq(dd, 0, "the peak starts again after the review");
        assertEq(peakAfter, perUnitAfter);
    }

    function test_ADepositThatWouldTripThePauseIsRefusedBeforeAnyPoke() public {
        seedAndOpen();
        vaultBuys(address(tokA), 40e6);
        setA(2.9e8);
        vm.prank(alice);
        vm.expectRevert(StrategyVaultV3.DepositsPaused.selector);
        sv.deposit(10e6, 0);
        assertVaultMode(AccountMode.NORMAL, "the refusal wrote nothing");
        sv.poke();
        assertVaultMode(AccountMode.PAUSED);
    }

    function test_FlowsNeverMoveTheSharePrice_SoTheBreakerIgnoresThem() public {
        threeDepositors();
        vaultBuys(address(tokA), 60e6);
        (, uint256 before,,) = sv.breakerState();
        passLockup();
        redeemAs(alice, sv.sharesOf(alice) / 2);
        redeemInKindAs(alice, sv.sharesOf(alice));
        depositAs(bob, 500e6);
        redeemInKindAs(bob, sv.freeShares(bob));
        (, uint256 after_, uint256 peak, uint256 dd) = sv.breakerState();
        assertGe(after_, before, "exits and deposits leave the spread in the vault");
        assertEq(dd, 0);
        assertEq(peak, after_);
        assertVaultMode(AccountMode.NORMAL);
    }

    function test_ReduceOnlyLetsDepositsAndExitsThrough() public {
        threeDepositors();
        vaultBuys(address(tokA), 60e6);
        vm.prank(sentinel);
        sv.setReduceOnly();
        depositAs(alice, 10e6);
        SwapParamsV3 memory buy = buyParams(10e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.ReduceOnly.selector, AccountMode.REDUCE_ONLY));
        executor.swap(sv, buy);
        vaultSells(address(tokA), 1e18);
        passLockup();
        redeemAs(alice, sv.sharesOf(alice) / 2);
        redeemInKindAs(alice, sv.sharesOf(alice));
    }

    // =====================================================================
    // The reference band (FINAL_PLAN 4.7.3, MV-S8)
    // =====================================================================

    function assertBandRefuses(address who) internal {
        vm.prank(who);
        vm.expectPartialRevert(StrategyVaultV3.OutsideBand.selector);
        sv.deposit(1e6, 0);
        uint256 shares = sv.sharesOf(who);
        vm.prank(who);
        vm.expectPartialRevert(StrategyVaultV3.OutsideBand.selector);
        sv.redeem(shares / 10, who, 0, uint64(block.timestamp + 60));
    }

    function test_TheBandRefusesDepositsAndUsdcExitsAfterAJump_AndResumesByItself() public {
        seedAndOpen();
        depositAs(alice, 100e6);
        assertEq(sv.refPriceE18(), 1e18, "the first priced deposit set the reference");
        vaultBuys(address(tokA), 80e6);
        passLockup();
        setA(12e8); // A doubles: 40% of the vault, the share price 1.4
        assertApproxEqRel(livePrice(), 1.4e18, 0.01e18);
        // A day passed since the reference was set, so it moves 10%; 1.4 is still outside.
        assertBandRefuses(alice);
        assertEq(sv.refPriceE18(), 1e18, "a refused call writes nothing");
        // In kind is never read against the band.
        redeemInKindAs(alice, sv.sharesOf(alice) / 10);
        sv.pokeReference();
        assertEq(sv.refPriceE18(), 1.1e18);
        warpDays(1);
        sv.pokeReference();
        assertEq(sv.refPriceE18(), 1.21e18);
        assertBandRefuses(alice);
        warpDays(1);
        sv.pokeReference();
        assertEq(sv.refPriceE18(), 1.331e18);
        // 1.4 is within 10% of 1.331: deposits and USDC exits resume without any admin.
        depositAs(alice, 1e6);
        redeemAs(alice, sv.sharesOf(alice) / 10);
    }

    function test_TheReferenceMovesAtMostTenPercentADay_InEitherDirection() public {
        seedAndOpen();
        depositAs(alice, 100e6);
        vaultBuys(address(tokA), 80e6);
        setA(12e8);
        warp(12 hours);
        sv.pokeReference();
        assertEq(sv.refPriceE18(), 1.05e18);
        warp(3 days);
        sv.pokeReference();
        assertEq(sv.refPriceE18(), 1.155e18, "a long gap moves one day's worth");
        setA(6e8);
        warpDays(1);
        sv.pokeReference();
        assertEq(sv.refPriceE18(), 1.0395e18);
        warpDays(1);
        sv.pokeReference();
        assertEq(sv.refPriceE18(), livePrice(), "it stops at the live price");
    }

    function test_TheBandIsSymmetric_AndTheBreakerPausesFirstOnALargeDrop() public {
        seedAndOpen();
        depositAs(alice, 100e6);
        vaultBuys(address(tokA), 80e6);
        // 12% down with no time for the reference to move: outside the band on the way down too.
        setA(4.2e8);
        assertApproxEqRel(livePrice(), 0.88e18, 0.005e18);
        vm.prank(bob);
        vm.expectPartialRevert(StrategyVaultV3.OutsideBand.selector);
        sv.deposit(1e6, 0);
        assertVaultMode(AccountMode.NORMAL, "the band refused it, not the breaker");
        // 25% down: the breaker's pause answers before the band.
        setA(2.25e8);
        vm.prank(bob);
        vm.expectRevert(StrategyVaultV3.DepositsPaused.selector);
        sv.deposit(1e6, 0);
    }

    /// M-28: a feed that lags the market by its deviation threshold (0.5%)
    /// cannot be arbitraged through the vault: the spread each way is as large.
    function test_LagArbitrageIsBoundedByTheSpread() public {
        seedAndOpen();
        vaultBuys(address(tokA), 45e6);
        warpDays(1);
        uint256 shares = depositAs(alice, 100e6);
        setA(6.03e8); // the feed catches up by 0.5%
        vm.prank(sentinel);
        sv.pause(); // waive the lock to let the round trip happen at once
        uint256 before = usdcBal(alice);
        redeemAs(alice, shares);
        assertLe(usdcBal(alice) - before, 100e6, "no profit from the lag");
    }

    // =====================================================================
    // The dormant performance fee (FINAL_PLAN 4.7.6, MV-V19)
    // =====================================================================

    function setFee(uint16 bps) internal {
        vm.prank(owner);
        sv.proposeFee(bps);
        warpDays(9);
        sv.applyFee();
    }

    function test_FeeProposalBoundsAndTimelock() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.BadFee.selector, uint16(2_001)));
        sv.proposeFee(2_001);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.NotManager.selector, alice));
        sv.proposeFee(100);
        vm.prank(owner);
        vm.expectEmit(address(sv));
        emit StrategyVaultV3.FeeProposed(1_000, uint64(block.timestamp + 9 days), uint64(block.timestamp + 16 days));
        sv.proposeFee(1_000);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.TooEarly.selector, uint64(block.timestamp + 9 days)));
        sv.applyFee();
        warpDays(9);
        vm.expectEmit(address(sv));
        emit StrategyVaultV3.FeeSet(0, 1_000);
        sv.applyFee();
        assertEq(sv.feeBps(), 1_000);
        // A later one lapses, and the guardian can cancel one.
        vm.prank(owner);
        sv.proposeFee(500);
        warpDays(17);
        vm.expectPartialRevert(StrategyVaultV3.Lapsed.selector);
        sv.applyFee();
        vm.prank(owner);
        sv.proposeFee(500);
        vm.prank(guardian);
        sv.cancelFeeProposal();
        warpDays(9);
        vm.expectRevert(StrategyVaultV3.NothingPending.selector);
        sv.applyFee();
        // And one proposed before a sale fails after it.
        vm.prank(owner);
        sv.proposeFee(500);
        nft.setOwner(AGENT, buyer);
        warpDays(9);
        vm.expectPartialRevert(StrategyVaultV3.StaleProposal.selector);
        sv.applyFee();
        assertEq(sv.feeBps(), 1_000);
    }

    function test_TheFeeIsChargedOnGainsOnly_InSharesToTheLeader_DilutingNobody() public {
        threeDepositors();
        setFee(1_000);
        vaultBuys(address(tokA), 120e6);
        uint256 bobValueBefore = sv.convertToAssets(sv.sharesOf(bob));
        setA(9e8); // A up 50%: the vault up 20%
        sv.poke();
        uint256 bobValueUp = sv.convertToAssets(sv.sharesOf(bob));
        assertGt(bobValueUp, bobValueBefore);
        uint256 shares = sv.sharesOf(alice) / 2;
        uint256 supply = sv.totalSupply();
        uint256 nav = sv.navUsdc();
        uint256 navSell = nav - Math.mulDiv(nav, 50, 10_000, Math.Rounding.Ceil);
        uint256 price = Math.mulDiv(navSell, 1e30, supply);
        uint256 entry = sv.entryPriceE18(alice);
        assertGt(price, entry);
        uint256 feeShares = Math.mulDiv(shares, (price - entry) * 1_000, price * 10_000);
        uint256 expected = Math.mulDiv(shares - feeShares, navSell, supply);
        uint256 leaderBefore = sv.leaderShares();
        vm.prank(alice);
        vm.expectEmit(address(sv));
        emit StrategyVaultV3.Redeemed(alice, alice, shares, expected, feeShares);
        uint256 out = sv.redeem(shares, alice, 0, uint64(block.timestamp + 60));
        assertEq(out, expected);
        assertEq(sv.leaderShares(), leaderBefore + feeShares);
        assertEq(sv.totalSupply(), supply - shares + feeShares);
        assertEq(sv.navUsdc(), nav - out);
        assertGe(sv.convertToAssets(sv.sharesOf(bob)), bobValueUp, "nobody else is diluted");
        // Alice's entry price is unchanged by the exit.
        assertEq(sv.entryPriceE18(alice), entry);
        // The leader's own exit, at the same gain, pays no fee.
        uint256 supplyBefore = sv.totalSupply();
        redeemAs(owner, 10e18);
        assertEq(sv.totalSupply(), supplyBefore - 10e18);
    }

    function test_NoFeeOnALoss_AndNoneForTheLeader() public {
        threeDepositors();
        setFee(2_000);
        vaultBuys(address(tokA), 120e6);
        setA(4.2e8); // A down 30%: the vault down 12%, inside the band the day's move allows
        uint256 shares = sv.sharesOf(alice) / 2;
        uint256 leaderBefore = sv.leaderShares();
        vm.prank(alice);
        vm.expectEmit(true, true, false, false, address(sv));
        emit StrategyVaultV3.Redeemed(alice, alice, shares, 0, 0);
        sv.redeem(shares, alice, 0, uint64(block.timestamp + 60));
        assertEq(sv.leaderShares(), leaderBefore, "no fee on a loss");
        uint256 supply = sv.totalSupply();
        redeemAs(owner, 10e18);
        assertEq(sv.totalSupply(), supply - 10e18, "the leader's exit moves exactly its shares");
    }

    function test_TheEntryPriceIsAWeightedAverage() public {
        seedAndOpen();
        uint256 s1 = depositAs(alice, 100e6);
        uint256 p1 = sv.entryPriceE18(alice);
        vaultBuys(address(tokA), 80e6);
        setA(7.2e8); // A up 20%: the vault up 8%, inside the band
        uint256 s2 = depositAs(alice, 100e6);
        uint256 p2 = Math.mulDiv(100e6, 1e30, s2);
        assertGt(p2, p1);
        assertEq(sv.entryPriceE18(alice), (p1 * s1 + p2 * s2) / (s1 + s2));
    }

    // =====================================================================
    // Trading hooks and the roles
    // =====================================================================

    function test_TheVaultNeverBuysAClassAToken() public {
        depositAs(owner, SEED);
        setVaultExecutor();
        SwapParamsV3 memory classA = attested(address(usdc), address(tokC), 5e6);
        vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.ClassAInVault.selector, address(tokC)));
        executor.swap(sv, classA);
        SwapParamsV3 memory screened = attested(address(usdc), address(tokD), 5e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotBuyable.selector, address(tokD)));
        executor.swap(sv, screened);
        assertFalse(tokens.buyableFor(address(tokD), address(sv)));
        // Class F core tokens trade, within the core's backstops.
        executor.swap(sv, buyParams(10e6));
        SwapParamsV3 memory large = buyParams(26e6);
        vm.expectPartialRevert(CustodyCoreV3.TradeTooLarge.selector);
        executor.swap(sv, large);
    }

    function test_AStaleEpochTradeReverts() public {
        depositAs(owner, SEED);
        setVaultExecutor();
        SwapParamsV3 memory p = buyParams(10e6);
        p.ownershipEpoch += 1;
        vm.expectRevert(
            abi.encodeWithSelector(StrategyVaultV3.StaleEpoch.selector, p.ownershipEpoch, p.ownershipEpoch - 1)
        );
        executor.swap(sv, p);
    }

    function test_OnlyTheExecutorTrades() public {
        depositAs(owner, SEED);
        setVaultExecutor();
        SwapParamsV3 memory p = buyParams(10e6);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotExecutor.selector, owner));
        sv.executeSwap(p);
        vm.prank(owner);
        vm.expectRevert(CustodyCoreV3.SwapContextInvalid.selector);
        sv.pullForSwap(address(usdc), 1);
        vaultFactory.setExecutor(address(0));
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotExecutor.selector, address(executor)));
        executor.swap(sv, p);
    }

    function test_TheTightenersTightenAndCannotLoosen() public {
        threeDepositors();
        address[2] memory keys = [guardian, sentinel];
        for (uint256 i = 0; i < keys.length; ++i) {
            vm.startPrank(keys[i]);
            sv.setReduceOnly();
            sv.closeDeposits();
            sv.pause();
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, keys[i]));
            sv.unpause();
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, keys[i]));
            sv.openDeposits();
            vm.expectRevert(abi.encodeWithSelector(StrategyVaultV3.NotManager.selector, keys[i]));
            sv.setDepositsOpen(true);
            vm.stopPrank();
            warpDays(1);
            vm.startPrank(owner);
            sv.unpause();
            sv.openDeposits();
            vm.stopPrank();
        }
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotTightener.selector, alice));
        sv.pause();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotTightener.selector, alice));
        sv.closeDeposits();
    }
}
