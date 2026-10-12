// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AccountFactoryV3} from "../../src/fund/AccountFactoryV3.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {ExecutorV3} from "../../src/fund/ExecutorV3.sol";
import {StrategyVaultV3} from "../../src/fund/StrategyVaultV3.sol";
import {AccountMode} from "../../src/interfaces/ICustody.sol";
import {ReasonV3, SwapIntentV3} from "../../src/interfaces/IExecutorV3.sol";
import {ExecutorV3Base} from "./ExecutorV3Base.sol";

/// A vault trading through Executor v3 (P7-U2): the factory's one vault per
/// agent, the grant without a fixed expiry that serves the vault alone and
/// ends only on a sale, a configuration change or revocation (D-241), class F
/// core tokens only for a vault (D-338), every hard limit as for a personal
/// account with the counters kept per account (MV-S7), the Executor's own
/// refusal of a vault in handover until the new owner accepts (MV-S13, M-24),
/// and the guardian's and admin's paths (M-04 to M-06 on the vault).
contract ExecutorV3VaultTest is ExecutorV3Base {
    StrategyVaultV3 internal sv;
    address internal alice = makeAddr("alice");
    address internal buyer = makeAddr("buyer");
    address internal vaultKey = makeAddr("vault session key");

    function setUp() public override {
        super.setUp();
        vm.prank(admin);
        factory.addDepositor(alice);
        vm.prank(admin);
        factory.addDepositor(buyer);
        vm.prank(owner);
        sv = StrategyVaultV3(factory.createVault(AGENT));
        address[3] memory wallets = [owner, alice, buyer];
        for (uint256 i = 0; i < wallets.length; ++i) {
            usdc.mint(wallets[i], 100_000e6);
            vm.prank(wallets[i]);
            usdc.approve(address(sv), type(uint256).max);
        }
        // The leader seeds 200 USDC, Alice adds 800: a 1,000 USDC vault, all USDC.
        vm.startPrank(owner);
        sv.deposit(200e6, 0);
        sv.setDepositsOpen(true);
        vm.stopPrank();
        vm.prank(alice);
        sv.deposit(800e6, 0);
    }

    // ----- helpers -----

    function vaultGrant() internal {
        vm.prank(owner);
        executor.registerVaultSession(AGENT, vaultKey);
    }

    /// An intent for the vault, through the natural route, at the floor the Executor accepts.
    function vaultIntent(address tokenIn, address tokenOut, uint256 amountIn) internal returns (SwapIntentV3 memory i) {
        i = intent(tokenIn, tokenOut, amountIn, floorFor(tokenIn, tokenOut, amountIn));
        i.account = address(sv);
    }

    function submitVault(SwapIntentV3 memory i) internal returns (uint256 out) {
        vm.prank(vaultKey);
        out = executor.swap(i);
    }

    function expectVaultRejected(SwapIntentV3 memory i, ReasonV3 reason) internal {
        vm.prank(vaultKey);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, reason));
        executor.swap(i);
    }

    // =====================================================================
    // The factory's vault
    // =====================================================================

    function test_TheFactoryDeploysOneVaultPerAgent_ForItsOwner() public {
        assertEq(factory.vaultOf(AGENT), address(sv));
        assertEq(factory.predictVault(AGENT), address(sv));
        assertTrue(factory.isAccount(address(sv)));
        assertEq(sv.leader(), owner);
        assertEq(address(sv.config()), address(factory));
        assertTrue(sv.isVault());
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.VaultExists.selector, address(sv)));
        factory.createVault(AGENT);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.NotAgentOwner.selector, stranger, owner));
        factory.createVault(AGENT);
        // The vault's deposits count in the platform total (with the base account's 1,000) and against the per-account cap for now.
        assertEq(factory.platformTotal(), 2_000e6);
        StrategyVaultV3 impl = StrategyVaultV3(factory.VAULT_IMPLEMENTATION());
        vm.expectRevert(StrategyVaultV3.AlreadyInitialized.selector);
        impl.initialize(1, stranger);
    }

    // =====================================================================
    // The vault grant (D-241)
    // =====================================================================

    function test_TheVaultGrantHasNoExpiry_AndTheOwnerAloneRegistersIt() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.NotAgentOwner.selector, stranger));
        executor.registerVaultSession(AGENT, vaultKey);
        vm.prank(owner);
        vm.expectRevert(ExecutorV3.BadSession.selector);
        executor.registerVaultSession(AGENT, address(0));
        // An agent without a vault gets no such grant.
        nft.setOwner(8, stranger);
        vm.prank(stranger);
        vm.expectRevert(ExecutorV3.BadSession.selector);
        executor.registerVaultSession(8, vaultKey);
        uint64 epoch = nft.ownerEpoch(AGENT);
        vm.prank(owner);
        vm.expectEmit(address(executor));
        emit ExecutorV3.SessionRegistered(AGENT, vaultKey, epoch, 0, 9_007_199_254_740_991);
        executor.registerVaultSession(AGENT, vaultKey);
        ExecutorV3.Grant memory g = executor.sessionOf(AGENT);
        assertEq(g.key, vaultKey);
        assertEq(g.validUntil, executor.NO_EXPIRY());
        // Far beyond any timed grant, it still trades.
        vm.warp(block.timestamp + 400 days);
        _refreshFeeds();
        submitVault(vaultIntent(address(usdc), address(wmon), 50e6));
        assertGt(wmon.balanceOf(address(sv)), 0);
    }

    function test_AVaultGrantNeverServesThePersonalAccount() public {
        vaultGrant();
        SwapIntentV3 memory i = intent(address(usdc), address(wmon), 10e6, floorFor(address(usdc), address(wmon), 10e6));
        vm.prank(vaultKey);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.INTENT_INVALID));
        executor.swap(i);
    }

    function test_ATimedGrantServesTheVaultToo_AndExpires() public {
        // The base's timed grant names `session`; the vault trades under it until it runs out.
        SwapIntentV3 memory i = vaultIntent(address(usdc), address(wmon), 50e6);
        vm.prank(session);
        executor.swap(i);
        vm.warp(block.timestamp + 8 days);
        _refreshFeeds();
        SwapIntentV3 memory later = vaultIntent(address(usdc), address(wmon), 50e6);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.SESSION_EXPIRED));
        executor.swap(later);
    }

    function test_TheVaultGrantEndsOnlyOnASaleAChangeOrRevocation() public {
        vaultGrant();
        submitVault(vaultIntent(address(usdc), address(wmon), 50e6));
        // A configuration change ends it.
        vm.prank(owner);
        executor.bumpConfigEpoch(AGENT);
        expectVaultRejected(vaultIntent(address(usdc), address(wmon), 50e6), ReasonV3.EPOCH_MISMATCH);
        vaultGrant();
        submitVault(vaultIntent(address(usdc), address(wmon), 50e6));
        // The owner's revocation ends it.
        vm.prank(owner);
        executor.revokeSession(AGENT);
        expectVaultRejected(vaultIntent(address(usdc), address(wmon), 50e6), ReasonV3.SESSION_UNKNOWN);
        vaultGrant();
        // A sale ends it; the intent's own epoch is stale too.
        nft.setOwner(AGENT, buyer);
        SwapIntentV3 memory stale = vaultIntent(address(usdc), address(wmon), 50e6);
        stale.ownerEpoch -= 1;
        expectVaultRejected(stale, ReasonV3.EPOCH_MISMATCH);
        expectVaultRejected(vaultIntent(address(usdc), address(wmon), 50e6), ReasonV3.EPOCH_MISMATCH);
    }

    // =====================================================================
    // Trading for the vault: M-04 on the vault, class F only, the counters
    // =====================================================================

    function test_AnAllowedSwapForTheVaultSucceeds_WithinEveryLimit() public {
        vaultGrant();
        uint256 usdcBefore = usdc.balanceOf(address(sv));
        uint256 supplyBefore = sv.totalSupply();
        SwapIntentV3 memory i = vaultIntent(address(usdc), address(wmon), 50e6);
        uint256 out = submitVault(i);
        assertEq(out, impliedFor(address(usdc), address(wmon), 50e6));
        assertEq(usdc.balanceOf(address(sv)), usdcBefore - 50e6);
        assertEq(wmon.balanceOf(address(sv)), out);
        assertEq(usdc.allowance(address(sv), address(executor)), 0);
        assertEq(usdc.balanceOf(address(executor)), 0);
        assertTrue(sv.isHeld(address(wmon)));
        assertEq(sv.costBasis(address(wmon)), 50e6);
        // The shares and the depositors' claims are untouched by the trade; the value per share holds.
        assertEq(sv.totalSupply(), supplyBefore);
        assertEq(sv.navUsdc(), 1_000e6);
        // Two hops too: USDC to A through WMON.
        SwapIntentV3 memory two = vaultIntent(address(usdc), address(tokA), 50e6);
        assertEq(two.route.length, 2);
        submitVault(two);
        assertTrue(sv.isHeld(address(tokA)));
    }

    function test_TheVaultNeverBuysAClassAOrAScreenedToken() public {
        vaultGrant();
        setAttestor();
        vaultGrant();
        // Class A in the core lane: refused by name before any price is read.
        SwapIntentV3 memory classA = vaultIntent(address(usdc), address(tokC), 50e6);
        attest(classA);
        expectVaultRejected(classA, ReasonV3.ASSET_NOT_ALLOWED);
        // A screened token: refused for the vault whatever the opt-in, as the asset, not the opt-in.
        SwapIntentV3 memory screened = vaultIntent(address(usdc), address(tokD), 50e6);
        attest(screened);
        expectVaultRejected(screened, ReasonV3.ASSET_NOT_ALLOWED);
        // The personal account still buys the class A token under a timed grant of its own
        // (one grant per agent: the owner switches the key's account by registering again).
        grant(uint64(block.timestamp + 7 days));
        SwapIntentV3 memory personal = trade(address(usdc), address(tokC), 50e6);
        vm.prank(session);
        executor.swap(personal);
        assertGt(tokC.balanceOf(address(account)), 0);
    }

    function test_TheHardLimitsHoldForTheVault() public {
        vaultGrant();
        // 10% of 1,000 is the Executor's trade cap: 100.000001 is refused.
        expectVaultRejected(vaultIntent(address(usdc), address(wmon), 100e6 + 1), ReasonV3.TRADE_SIZE_EXCEEDED);
        submitVault(vaultIntent(address(usdc), address(wmon), 100e6));
        // The 40% concentration cap on WMON, projected before the trade.
        for (uint256 k = 0; k < 3; ++k) {
            submitVault(vaultIntent(address(usdc), address(wmon), 100e6));
        }
        expectVaultRejected(vaultIntent(address(usdc), address(wmon), 10e6), ReasonV3.CONCENTRATION_CAP);
        // Slippage below the floor is refused.
        SwapIntentV3 memory low = vaultIntent(address(usdc), address(tokA), 50e6);
        low.minAmountOut = low.minAmountOut - 1;
        expectVaultRejected(low, ReasonV3.SLIPPAGE_TOO_HIGH);
        // A sale into USDC always passes the caps.
        submitVault(vaultIntent(address(wmon), address(usdc), 10e18));
    }

    /// MV-S7 on vault counters: the vault and the owner's personal account have separate rings.
    function test_TheCountersAreKeptPerAccount() public {
        vaultGrant();
        for (uint256 k = 0; k < 5; ++k) {
            submitVault(vaultIntent(address(usdc), address(wmon), 20e6));
        }
        (, uint256 vaultLeft,, uint256 vaultUsed) = executor.limits(address(sv));
        (, uint256 personalLeft,, uint256 personalUsed) = executor.limits(address(account));
        assertEq(vaultLeft, 15);
        assertEq(vaultUsed, 100e6);
        assertEq(personalLeft, 20);
        assertEq(personalUsed, 0);
        // The vault's 20-trade window fills on its own.
        for (uint256 k = 0; k < 15; ++k) {
            submitVault(vaultIntent(address(usdc), address(wmon), 1e6));
        }
        expectVaultRejected(vaultIntent(address(usdc), address(wmon), 1e6), ReasonV3.DAILY_TRADE_LIMIT);
        // The personal account, under a timed grant registered in the vault grant's place, has its own window.
        grant(uint64(block.timestamp + 7 days));
        SwapIntentV3 memory personal =
            intent(address(usdc), address(wmon), 10e6, floorFor(address(usdc), address(wmon), 10e6));
        vm.prank(session);
        executor.swap(personal);
    }

    function test_TheVaultsOwnBackstopsStandBehindTheExecutor() public view {
        // The core's constants are the vault's: looser than the policy, never checked on exits.
        assertEq(sv.MAX_TRADE_BPS(), 1_200);
        assertEq(sv.MAX_ASSET_BPS(), 4_500);
        assertEq(sv.MAX_SLIPPAGE_BPS(), 100);
        assertGt(sv.MAX_TRADE_BPS(), executor.policy().maxTradeBps);
        assertGt(sv.MAX_ASSET_BPS(), executor.policy().maxAssetBps);
        assertGt(sv.MAX_SLIPPAGE_BPS(), executor.policy().maxSlippageBps);
    }

    // =====================================================================
    // Modes and handover in the Executor (MV-S13, M-24)
    // =====================================================================

    function test_ReduceOnlyAndPausedHoldForTheVault() public {
        vaultGrant();
        submitVault(vaultIntent(address(usdc), address(wmon), 100e6));
        vm.prank(sentinel);
        sv.setReduceOnly();
        expectVaultRejected(vaultIntent(address(usdc), address(wmon), 10e6), ReasonV3.REDUCE_ONLY_MODE);
        submitVault(vaultIntent(address(wmon), address(usdc), 5e18));
        vm.prank(guardian);
        sv.pause();
        expectVaultRejected(vaultIntent(address(wmon), address(usdc), 5e18), ReasonV3.PAUSED);
        // Exits are never the Executor's business: Alice leaves in kind while paused.
        uint256 shares = sv.sharesOf(alice);
        vm.prank(alice);
        sv.redeemInKind(shares, alice);
        assertGt(wmon.balanceOf(alice), 0);
    }

    function test_WindDownIsReduceOnlyForTheExecutor() public {
        vaultGrant();
        submitVault(vaultIntent(address(usdc), address(wmon), 100e6));
        vm.prank(owner);
        sv.closeVault();
        expectVaultRejected(vaultIntent(address(usdc), address(wmon), 10e6), ReasonV3.REDUCE_ONLY_MODE);
        submitVault(vaultIntent(address(wmon), address(usdc), 5e18));
    }

    function test_NothingTradesForAVaultInHandover_UntilTheNewOwnerAccepts() public {
        vaultGrant();
        submitVault(vaultIntent(address(usdc), address(wmon), 100e6));
        nft.setOwner(AGENT, buyer);
        // The old grant is dead with the epoch; the new owner's own grant meets the handover.
        vm.prank(buyer);
        executor.registerVaultSession(AGENT, vaultKey);
        expectVaultRejected(vaultIntent(address(usdc), address(wmon), 10e6), ReasonV3.VAULT_IN_HANDOVER);
        expectVaultRejected(vaultIntent(address(wmon), address(usdc), 5e18), ReasonV3.VAULT_IN_HANDOVER);
        assertEq(uint8(sv.effectiveMode()), uint8(AccountMode.HANDOVER));
        // Depositors leave freely meanwhile.
        uint256 shares = sv.sharesOf(alice);
        vm.prank(alice);
        sv.redeemInKind(shares / 2, alice);
        // The buyer stakes 5% and accepts after the handover period; trading resumes under the same grant.
        vm.prank(buyer);
        sv.stakeAsIncomingLeader(100e6, 0);
        vm.warp(block.timestamp + 3 days);
        _refreshFeeds();
        vm.prank(buyer);
        sv.acceptManagement();
        assertFalse(sv.inHandover());
        submitVault(vaultIntent(address(usdc), address(wmon), 10e6));
        // The old owner cannot register anything for the agent any more.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.NotAgentOwner.selector, owner));
        executor.registerVaultSession(AGENT, vaultKey);
    }

    // =====================================================================
    // The guardian's and the admin's paths
    // =====================================================================

    function test_TheGuardianStopsVaultTradingAtOnce_AndNeverTouchesExits() public {
        vaultGrant();
        submitVault(vaultIntent(address(usdc), address(wmon), 100e6));
        vm.prank(guardian);
        executor.pauseAll();
        expectVaultRejected(vaultIntent(address(wmon), address(usdc), 5e18), ReasonV3.PAUSED);
        uint256 shares = sv.sharesOf(alice);
        vm.warp(block.timestamp + 1 days + 1);
        _refreshFeeds();
        vm.prank(alice);
        sv.redeem(shares / 4, alice, 0, uint64(block.timestamp + 60));
        vm.prank(alice);
        sv.redeemInKind(shares / 4, alice);
    }

    function test_ClearingTheExecutorStopsVaultTrading() public {
        vaultGrant();
        vm.prank(guardian);
        factory.clearExecutor();
        SwapIntentV3 memory i = vaultIntent(address(usdc), address(wmon), 50e6);
        vm.prank(vaultKey);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotExecutor.selector, address(executor)));
        executor.swap(i);
    }

    /// M-06 on the vault: the Executor itself cannot move the vault's funds outside a swap.
    function test_TheExecutorMovesNothingOutsideASwap() public {
        vm.startPrank(address(executor));
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, address(executor)));
        sv.withdraw(address(usdc), 1, address(executor));
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, address(executor)));
        sv.withdrawAll(address(executor));
        vm.expectRevert(CustodyCoreV3.SwapContextInvalid.selector);
        sv.pullForSwap(address(usdc), 1);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(sv)), 1_000e6);
    }
}
