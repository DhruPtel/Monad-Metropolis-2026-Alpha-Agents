// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {AccountFactoryV3} from "../../src/fund/AccountFactoryV3.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {AccountMode, IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {FeedConfig, ITokenRegistry, PriceClass, PriceReason} from "../../src/interfaces/IFund.sol";
import {FeeOnTransferToken, GasBurner, MockToken, RevertingLedger} from "../mocks/CustodyMocks.sol";
import {BalanceRevertingToken, GasBurningToken, ReturnBombToken} from "../mocks/CustodyV3Mocks.sol";
import {MockFeed} from "../mocks/OracleMocks.sol";
import {CustodyV3Base} from "./CustodyV3Base.sol";

/// The custody core v3 in single-owner mode (F-U3): creation, deposits of
/// many tokens, withdrawals that never need a price, credits for tokens that
/// refuse to move, hostile held tokens, and the tighten-only roles. Every v2
/// guarantee is here again, over a portfolio instead of a pair.
contract PersonalAccountV3Test is CustodyV3Base {
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
        assertEq(account.USDC(), address(usdc));
        assertEq(address(account.TOKENS()), address(tokens));
        assertHeld(one(address(usdc)));
        assertTrue(account.isHeld(address(usdc)));
        assertFalse(account.isVault());
        assertFalse(account.screenedOptIn());
    }

    function test_OnlyTheAgentsOwnerCreates_AndOnlyOnce() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.NotAgentOwner.selector, stranger, owner));
        factory.createPersonalAccount(AGENT);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.AccountExists.selector, address(account)));
        factory.createPersonalAccount(AGENT);
    }

    function test_InitializesOnce_AndTheImplementationIsLocked() public {
        vm.expectRevert(PersonalAccountV3.AlreadyInitialized.selector);
        account.initialize(1, stranger);
        PersonalAccountV3 impl = PersonalAccountV3(factory.PERSONAL_ACCOUNT_IMPLEMENTATION());
        vm.expectRevert(PersonalAccountV3.AlreadyInitialized.selector);
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

    /// USDC is the unit of account and the first held token, so the factory
    /// refuses a USDC the registry does not list in its core lane.
    function test_TheFactoryNeedsUsdcInTheRegistrysCoreLane() public {
        address[] memory allow = new address[](0);
        AccountFactoryV3.Deployment memory d = AccountFactoryV3.Deployment({
            admin: admin,
            guardian: guardian,
            sentinel: sentinel,
            oracle: address(oracle),
            executor: address(0),
            agentNft: IAgentNFTView(address(nft)),
            usdc: address(tokD),
            tokenRegistry: ITokenRegistry(address(tokens)),
            personalCap: PERSONAL_CAP,
            platformCap: PLATFORM_CAP,
            allowlist: allow
        });
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.UsdcNotCore.selector, address(tokD)));
        new AccountFactoryV3(d);
        d.usdc = makeAddr("unknown");
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.UsdcNotCore.selector, d.usdc));
        new AccountFactoryV3(d);
    }

    // =====================================================================
    // Deposits
    // =====================================================================

    function test_DepositsUsdc_CountingPrincipalAndThePlatformTotal() public {
        usdc.mint(owner, 40e6);
        vm.startPrank(owner);
        usdc.approve(address(account), 40e6);
        vm.expectEmit(address(account));
        emit PersonalAccountV3.Deposited(address(usdc), 40e6, 40e6, 40e6);
        account.deposit(address(usdc), 40e6);
        vm.stopPrank();
        assertEq(usdcBal(address(account)), 40e6);
        assertEq(account.principal(), 40e6);
        assertEq(factory.platformTotal(), 40e6);
        assertEq(account.costBasis(address(usdc)), 40e6, "USDC's basis is its balance");
        assertEq(account.units(), 40e18);
    }

    function test_DepositsCoreClassFTokens_ValuedThroughTheOracle_WithTheirCostBasis() public {
        deposit(usdc, 100e6);
        tokA.mint(owner, 10e18);
        vm.startPrank(owner);
        tokA.approve(address(account), 10e18);
        vm.expectEmit(address(account));
        emit CustodyCoreV3.HeldTokenAdded(address(tokA), 18);
        account.deposit(address(tokA), 10e18); // 60 USDC
        vm.stopPrank();
        deposit(tokB, 1e8); // 40 USDC, a composite: 20 MON at 2 USDC
        depositWmon(5e18); // 10 USDC
        assertEq(account.principal(), 210e6);
        assertEq(account.navUsdc(), 210e6);
        assertEq(account.costBasis(address(tokA)), 60e6);
        assertEq(account.costBasis(address(tokB)), 40e6);
        assertEq(account.costBasis(address(wmon)), 10e6);
        (uint256 px, uint64 pricedAt) = account.lastPrice(address(tokB));
        assertEq(px, 40e18);
        assertEq(pricedAt, block.timestamp);
        address[] memory held = new address[](4);
        (held[0], held[1], held[2], held[3]) = (address(usdc), address(tokA), address(tokB), address(wmon));
        assertHeld(held);
        CustodyCoreV3.Holding[] memory h = account.holdings();
        assertEq(h.length, 4);
        assertEq(h[1].token, address(tokA));
        assertEq(h[1].decimals, 18);
        assertEq(h[1].balance, 10e18);
        assertEq(h[1].costBasis, 60e6);
        assertEq(h[1].lastPriceE18, 6e18);
    }

    /// Only USDC and buyable core-lane class F tokens are deposited: never a
    /// screened token, a class A token or one the registry has restricted.
    function test_DepositRefusals() public {
        usdc.mint(owner, 10_000e6);
        vm.prank(owner);
        usdc.approve(address(account), type(uint256).max);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, stranger));
        account.deposit(address(usdc), 1e6);

        vm.startPrank(owner);
        vm.expectRevert(CustodyCoreV3.ZeroAmount.selector);
        account.deposit(address(usdc), 0);
        vm.expectRevert(abi.encodeWithSelector(PersonalAccountV3.NotDepositable.selector, address(tokD)));
        account.deposit(address(tokD), 1e6);
        vm.expectRevert(abi.encodeWithSelector(PersonalAccountV3.NotDepositable.selector, address(tokC)));
        account.deposit(address(tokC), 1e18);
        MockToken other = new MockToken("OTHER", 6);
        vm.expectRevert(abi.encodeWithSelector(PersonalAccountV3.NotDepositable.selector, address(other)));
        account.deposit(address(other), 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(AccountFactoryV3.PersonalCapExceeded.selector, PERSONAL_CAP + 1, PERSONAL_CAP)
        );
        account.deposit(address(usdc), PERSONAL_CAP + 1);
        vm.stopPrank();

        vm.prank(SCREENER);
        tokens.setSellOnly(address(tokA));
        tokA.mint(owner, 1e18);
        vm.startPrank(owner);
        tokA.approve(address(account), 1e18);
        vm.expectRevert(abi.encodeWithSelector(PersonalAccountV3.NotDepositable.selector, address(tokA)));
        account.deposit(address(tokA), 1e18);
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
        vm.expectRevert(PersonalAccountV3.DepositsPaused.selector);
        account.deposit(address(usdc), 1e6);

        vm.prank(owner);
        account.unpause();
        vm.prank(guardian);
        account.closeDeposits();
        vm.prank(owner);
        vm.expectRevert(PersonalAccountV3.DepositsAreClosed.selector);
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
        vm.expectRevert(abi.encodeWithSelector(PersonalAccountV3.NotAgentOwner.selector, makeAddr("buyer")));
        account.deposit(address(usdc), 1e6);
        vm.stopPrank();
    }

    function test_AWalletOffTheAllowlistCannotDeposit() public {
        address outsider = makeAddr("outsider");
        nft.setOwner(99, outsider);
        vm.prank(outsider);
        PersonalAccountV3 theirs = PersonalAccountV3(factory.createPersonalAccount(99));
        usdc.mint(outsider, 1e6);
        vm.startPrank(outsider);
        usdc.approve(address(theirs), 1e6);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.NotAllowlisted.selector, outsider));
        theirs.deposit(address(usdc), 1e6);
        vm.stopPrank();
    }

    function test_RefusesAFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        MockFeed f = new MockFeed(8);
        f.push(1e8);
        extraFeeds.push(f);
        timelockedRegistry(
            tokens.ADD_CORE(),
            abi.encode(
                TokenRegistry.CoreSeed(address(fot), PriceClass.F, 4_500, FeedConfig(_feed(f, 8, 3_900), _noLeg()))
            )
        );
        fot.mint(owner, 10e6);
        vm.startPrank(owner);
        fot.approve(address(account), 10e6);
        vm.expectRevert(abi.encodeWithSelector(PersonalAccountV3.TransferNotExact.selector, address(fot), 9.9e6, 10e6));
        account.deposit(address(fot), 10e6);
        vm.stopPrank();
    }

    /// The depeg guard (A-34) stops deposits, and nothing else: valuation,
    /// trades and withdrawals never read USDC/USD.
    function test_TheDepegGuardStopsDepositsOnly() public {
        deposit(usdc, 50e6);
        usdcUsd.push(98_000_000);
        usdc.mint(owner, 1e6);
        vm.startPrank(owner);
        usdc.approve(address(account), 1e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.UsdcDepegged.selector, 0.98e18));
        account.deposit(address(usdc), 1e6);
        vm.stopPrank();
        assertEq(account.navUsdc(), 50e6);
        vm.prank(owner);
        account.withdraw(address(usdc), 10e6, owner);

        // Exactly 1% off passes; stale fails with the feed's own reason.
        usdcUsd.push(99_000_000);
        vm.prank(owner);
        account.deposit(address(usdc), 1e6);
        vm.warp(block.timestamp + 3_900);
        monUsd.push(2e8);
        aUsd.push(6e8);
        bRate.push(20e18);
        usdc.mint(owner, 1e6);
        vm.startPrank(owner);
        usdc.approve(address(account), 1e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.UsdcFeedUnusable.selector, PriceReason.STALE));
        account.deposit(address(usdc), 1e6);
        vm.stopPrank();
    }

    /// A deposit values the whole portfolio, so one unusable class F feed
    /// fails it closed; the withdrawal of anything still works.
    function test_ADepositFailsClosedWhenAHeldFeedIsUnusable_WithdrawalDoesNot() public {
        deposit(usdc, 50e6);
        deposit(tokA, 10e18);
        aUsd.setFailure(MockFeed.Failure.RevertRound);
        usdc.mint(owner, 1e6);
        vm.startPrank(owner);
        usdc.approve(address(account), 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(OracleAdapterV3.PriceUnavailable.selector, address(tokA), PriceReason.FEED_REVERTED)
        );
        account.deposit(address(usdc), 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(OracleAdapterV3.PriceUnavailable.selector, address(tokA), PriceReason.FEED_REVERTED)
        );
        account.navUsdc();
        account.withdraw(address(tokA), 10e18, owner);
        account.withdrawAll(owner);
        vm.stopPrank();
        // The 50 deposited came back, beside the 1 minted for the refused deposit.
        assertEq(usdcBal(owner), 51e6);
        assertEq(tokA.balanceOf(owner), 10e18);
    }

    function test_AnAccountWithoutAnOracleRefusesDeposits() public {
        address[] memory allow = new address[](1);
        allow[0] = owner;
        AccountFactoryV3 bare = new AccountFactoryV3(
            AccountFactoryV3.Deployment({
                admin: admin,
                guardian: guardian,
                sentinel: sentinel,
                oracle: address(0),
                executor: address(0),
                agentNft: IAgentNFTView(address(nft)),
                usdc: address(usdc),
                tokenRegistry: ITokenRegistry(address(tokens)),
                personalCap: PERSONAL_CAP,
                platformCap: PLATFORM_CAP,
                allowlist: allow
            })
        );
        nft.setOwner(8, owner);
        vm.prank(owner);
        PersonalAccountV3 fresh = PersonalAccountV3(bare.createPersonalAccount(8));
        usdc.mint(owner, 10e6);
        vm.startPrank(owner);
        usdc.approve(address(fresh), 10e6);
        vm.expectRevert(CustodyCoreV3.OracleUnset.selector);
        fresh.deposit(address(usdc), 10e6);
        vm.stopPrank();
    }

    /// The held list holds 16 tokens, USDC included (A-62): a 17th is refused
    /// by a deposit, and withdrawing frees the slots again.
    function test_TheHeldListStopsAtSixteenTokens() public {
        MockToken[] memory more = coreTokens(15);
        deposit(tokA, 1e18);
        for (uint256 i = 0; i < 14; ++i) {
            deposit(more[i], 1e18);
        }
        assertEq(account.heldCount(), 16);
        more[14].mint(owner, 1e18);
        vm.startPrank(owner);
        more[14].approve(address(account), 1e18);
        vm.expectRevert(CustodyCoreV3.TooManyHeldTokens.selector);
        account.deposit(address(more[14]), 1e18);
        account.withdrawAll(owner);
        vm.stopPrank();
        assertHeld(one(address(usdc)));
        deposit(more[14], 1e18);
        assertEq(account.heldCount(), 2);
        assertEq(account.navUsdc(), 1e6);
    }

    // =====================================================================
    // Withdrawals: always on, owner only, no price
    // =====================================================================

    function test_TheOwnerWithdraws_ToAnyAddress() public {
        deposit(usdc, 50e6);
        address elsewhere = makeAddr("elsewhere");
        vm.prank(owner);
        vm.expectEmit(address(account));
        emit CustodyCoreV3.Withdrawn(address(usdc), 30e6, elsewhere);
        account.withdraw(address(usdc), 30e6, elsewhere);
        assertEq(usdcBal(elsewhere), 30e6);
        assertEq(usdcBal(address(account)), 20e6);
    }

    function test_TheOwnerWithdrawsInEveryModeAndWithDepositsClosed() public {
        deposit(usdc, 30e6);
        deposit(tokA, 5e18);
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
        account.withdraw(address(tokA), 1e18, owner);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(address(account)) + tokA.balanceOf(address(account)), 0);
        assertEq(usdcBal(owner), 30e6);
        assertEq(tokA.balanceOf(owner), 5e18);
    }

    /// The withdrawal needs nothing but the owner and the tokens: the factory,
    /// AgentNFT, oracle, registry and Executor may all be broken.
    function test_WithdrawalWorksWithEveryOtherContractBroken() public {
        tradingAccount();
        deposit(tokB, 1e8);
        depositWmon(5e18);
        vm.etch(address(factory), address(new RevertingLedger()).code);
        vm.etch(address(nft), address(new RevertingLedger()).code);
        vm.etch(address(oracle), address(new RevertingLedger()).code);
        vm.etch(address(tokens), address(new RevertingLedger()).code);
        vm.etch(address(executor), address(new RevertingLedger()).code);
        vm.prank(owner);
        account.withdraw(address(usdc), 10e6, owner);
        vm.prank(owner);
        account.withdraw(address(tokB), 1e7, owner);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 600e6);
        assertEq(tokA.balanceOf(owner), 50e18);
        assertEq(tokB.balanceOf(owner), 1e8);
        assertEq(wmon.balanceOf(owner), 5e18);
        assertHeld(one(address(usdc)));
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
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, others[i]));
            account.withdraw(address(usdc), 1, others[i]);
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, others[i]));
            account.withdrawAll(others[i]);
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotClaimant.selector, others[i]));
            account.claim(address(usdc), others[i]);
            vm.stopPrank();
        }
        assertEq(usdcBal(address(account)), 50e6);
    }

    function test_WithdrawalRefusesABadRecipientOrZero() public {
        deposit(usdc, 5e6);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.BadRecipient.selector, address(0)));
        account.withdraw(address(usdc), 1, address(0));
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.BadRecipient.selector, address(account)));
        account.withdrawAll(address(account));
        vm.expectRevert(CustodyCoreV3.ZeroAmount.selector);
        account.withdraw(address(usdc), 0, owner);
        vm.stopPrank();
    }

    function test_ASellerKeepsTheirWithdrawal_AndTheBuyerCannotTouchIt() public {
        deposit(usdc, 50e6);
        address buyer = makeAddr("buyer");
        nft.setOwner(AGENT, buyer);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, buyer));
        account.withdraw(address(usdc), 1, buyer);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 50e6);
    }

    /// Any token can be withdrawn, held or not: an unregistered stray, and a
    /// registered token that was sent in without a deposit.
    function test_AStrayTokenCanBeWithdrawn() public {
        MockToken stray = new MockToken("STRAY", 18);
        stray.mint(address(account), 5e18);
        tokC.mint(address(account), 3e18);
        vm.startPrank(owner);
        account.withdraw(address(stray), 5e18, owner);
        account.withdraw(address(tokC), 3e18, owner);
        vm.stopPrank();
        assertEq(stray.balanceOf(owner), 5e18);
        assertEq(tokC.balanceOf(owner), 3e18);
        assertHeld(one(address(usdc)));
    }

    function test_WithdrawAllPaysEveryHeldToken_AndLeavesOnlyUsdcOnTheList() public {
        deposit(usdc, 100e6);
        deposit(tokA, 10e18);
        deposit(tokB, 1e8);
        depositWmon(5e18);
        assertEq(account.heldCount(), 4);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 100e6);
        assertEq(tokA.balanceOf(owner), 10e18);
        assertEq(tokB.balanceOf(owner), 1e8);
        assertEq(wmon.balanceOf(owner), 5e18);
        assertHeld(one(address(usdc)));
        assertEq(account.costBasis(address(tokA)), 0);
        assertEq(account.units(), 0);
        assertEq(account.principal(), 0);
        assertEq(factory.platformTotal(), 0);
    }

    function test_WithdrawingATokenEntirelyRemovesItFromTheList_AndItsBasis() public {
        deposit(usdc, 100e6);
        deposit(tokA, 10e18);
        deposit(tokB, 1e8);
        vm.prank(owner);
        vm.expectEmit(address(account));
        emit CustodyCoreV3.HeldTokenRemoved(address(tokA));
        account.withdraw(address(tokA), 10e18, owner);
        assertHeld(two(address(usdc), address(tokB)));
        assertEq(account.costBasis(address(tokA)), 0);
        assertFalse(account.isHeld(address(tokA)));
        // The moved token's slot is right.
        deposit(tokA, 1e18);
        address[] memory held = new address[](3);
        (held[0], held[1], held[2]) = (address(usdc), address(tokB), address(tokA));
        assertHeld(held);
    }

    /// A withdrawal takes its share of the token's cost basis with it, with no price.
    function test_AWithdrawalTakesItsShareOfTheCostBasis() public {
        deposit(tokA, 10e18); // basis 60 USDC
        vm.prank(owner);
        vm.expectEmit(address(account));
        emit CustodyCoreV3.CostBasisChanged(address(tokA), 60e6, 36e6);
        account.withdraw(address(tokA), 4e18, owner);
        assertEq(account.costBasis(address(tokA)), 36e6);
        // A USDC withdrawal lowers the principal; another token's does not.
        deposit(usdc, 50e6);
        assertEq(account.principal(), 110e6);
        vm.prank(owner);
        account.withdraw(address(usdc), 20e6, owner);
        assertEq(account.principal(), 90e6);
        assertEq(factory.platformTotal(), 90e6);
    }

    // =====================================================================
    // A reverting token: skipped, credited, claimable later (D-071)
    // =====================================================================

    function test_ABlacklistedTokenIsCredited_AndTheRestStillWithdraws() public {
        deposit(usdc, 40e6);
        deposit(tokA, 10e18);
        depositWmon(5e18);
        usdc.setBlocked(address(account), true);

        vm.prank(owner);
        vm.expectEmit(address(account));
        emit CustodyCoreV3.ClaimableCredited(address(usdc), owner, 40e6, 40e6);
        account.withdrawAll(owner);
        assertEq(tokA.balanceOf(owner), 10e18);
        assertEq(wmon.balanceOf(owner), 5e18);
        assertEq(usdcBal(address(account)), 40e6);
        assertEq(account.claimable(address(usdc), owner), 40e6);
        assertEq(account.totalClaimable(address(usdc)), 40e6);
        assertEq(account.freeBalance(address(usdc)), 0);
        // Credits are excluded from valuation and the credited token stays listed while it is there.
        assertEq(account.navUsdc(), 0);
        assertHeld(one(address(usdc)));

        vm.prank(owner);
        vm.expectRevert();
        account.claim(address(usdc), owner);
        assertEq(account.claimable(address(usdc), owner), 40e6);

        usdc.setBlocked(address(account), false);
        address elsewhere = makeAddr("elsewhere");
        vm.prank(owner);
        vm.expectEmit(address(account));
        emit CustodyCoreV3.CreditClaimed(address(usdc), owner, 40e6, elsewhere);
        account.claim(address(usdc), elsewhere);
        assertEq(usdcBal(elsewhere), 40e6);
        assertEq(account.claimable(address(usdc), owner), 0);
        assertEq(account.totalClaimable(address(usdc)), 0);
        assertEq(account.principal(), 0);
    }

    /// A credited token other than USDC leaves the list only when it is finally claimed.
    function test_ACreditedTokenLeavesTheListWhenClaimed() public {
        deposit(usdc, 40e6);
        deposit(tokA, 10e18);
        tokA.setBlocked(owner, true);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 40e6);
        assertEq(account.claimable(address(tokA), owner), 10e18);
        assertHeld(two(address(usdc), address(tokA)));
        address safe = makeAddr("safe");
        vm.prank(owner);
        account.claim(address(tokA), safe);
        assertEq(tokA.balanceOf(safe), 10e18);
        assertHeld(one(address(usdc)));
        assertEq(account.costBasis(address(tokA)), 0);
    }

    function test_APausedTokenIsCredited_AndABlacklistedOwnerClaimsToAnotherAddress() public {
        deposit(usdc, 40e6);
        usdc.setBlocked(owner, true);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(account.claimable(address(usdc), owner), 40e6);
        address safe = makeAddr("safe");
        vm.prank(owner);
        account.claim(address(usdc), safe);
        assertEq(usdcBal(safe), 40e6);
        usdc.setBlocked(owner, false);

        deposit(usdc, 10e6);
        usdc.setPaused(true);
        vm.prank(owner);
        account.withdrawAll(safe);
        assertEq(account.claimable(address(usdc), owner), 10e6);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NothingToClaim.selector, address(tokA)));
        account.claim(address(tokA), safe);
    }

    function test_AWithdrawalOfACreditedTokenLowersTheCredit() public {
        deposit(usdc, 40e6);
        usdc.setBlocked(address(account), true);
        vm.prank(owner);
        account.withdrawAll(owner);
        usdc.setBlocked(address(account), false);
        vm.prank(owner);
        account.withdraw(address(usdc), 30e6, owner);
        assertEq(account.claimable(address(usdc), owner), 10e6);
        assertEq(account.totalClaimable(address(usdc)), 10e6);
        // A later withdrawAll that succeeds clears what is left.
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(account.claimable(address(usdc), owner), 0);
        assertEq(account.totalClaimable(address(usdc)), 0);
        assertEq(usdcBal(owner), 40e6);
    }

    // =====================================================================
    // Hostile held tokens never block the others
    // =====================================================================

    function _hostileCore(MockToken t) internal {
        MockFeed f = new MockFeed(8);
        f.push(1e8);
        extraFeeds.push(f);
        timelockedRegistry(
            tokens.ADD_CORE(),
            abi.encode(
                TokenRegistry.CoreSeed(address(t), PriceClass.F, 4_500, FeedConfig(_feed(f, 8, 3_900), _noLeg()))
            )
        );
    }

    function test_ATokenWhoseBalanceReadRevertsNeverBlocksTheOthers() public {
        BalanceRevertingToken bad = new BalanceRevertingToken();
        _hostileCore(bad);
        deposit(usdc, 40e6);
        deposit(tokA, 10e18);
        deposit(bad, 3e18);
        bad.arm(true);
        // Single withdrawals of the other tokens read every held balance for the empty check: still fine.
        vm.prank(owner);
        account.withdraw(address(usdc), 10e6, owner);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 40e6);
        assertEq(tokA.balanceOf(owner), 10e18);
        // The unreadable token is skipped, not credited, and stays listed.
        assertEq(account.claimable(address(bad), owner), 0);
        assertTrue(account.isHeld(address(bad)));
        bad.arm(false);
        vm.prank(owner);
        account.withdraw(address(bad), 3e18, owner);
        assertEq(bad.balanceOf(owner), 3e18);
        assertHeld(one(address(usdc)));
    }

    function test_AGasBurningTokenIsCreditedAndTheOthersComeOut() public {
        GasBurningToken burner = new GasBurningToken();
        _hostileCore(burner);
        deposit(usdc, 40e6);
        deposit(burner, 3e18);
        deposit(tokA, 10e18);
        burner.arm(true);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 40e6);
        assertEq(tokA.balanceOf(owner), 10e18);
        assertEq(account.claimable(address(burner), owner), 3e18);
        burner.arm(false);
        vm.prank(owner);
        account.claim(address(burner), owner);
        assertEq(burner.balanceOf(owner), 3e18);
    }

    function test_AReturnBombTokenIsCreditedOrSkipped_AndTheOthersComeOut() public {
        ReturnBombToken bomb = new ReturnBombToken();
        _hostileCore(bomb);
        deposit(usdc, 40e6);
        deposit(bomb, 3e18);
        deposit(tokA, 10e18);
        bomb.armTransfer(true);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 40e6);
        assertEq(tokA.balanceOf(owner), 10e18);
        assertEq(account.claimable(address(bomb), owner), 3e18, "a bombing transfer counts as failed");
        bomb.armTransfer(false);
        deposit(usdc, 5e6);
        bomb.armBalance(true);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 45e6, "a bombing balance read is skipped");
        bomb.armBalance(false);
        vm.prank(owner);
        account.claim(address(bomb), owner);
        assertEq(bomb.balanceOf(owner), 3e18);
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
            emit CustodyCoreV3.ModeChanged(AccountMode.NORMAL, AccountMode.REDUCE_ONLY, tighteners[i]);
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
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotTightener.selector, others[i]));
            account.setReduceOnly();
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotTightener.selector, others[i]));
            account.pause();
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotTightener.selector, others[i]));
            account.closeDeposits();
            vm.stopPrank();
        }
    }

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
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, roles[i]));
            account.unpause();
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, roles[i]));
            account.openDeposits();
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, roles[i]));
            account.setScreenedOptIn(true);
            vm.stopPrank();
        }
        assertMode(AccountMode.PAUSED);
        assertTrue(account.depositsClosed());
        vm.prank(owner);
        account.unpause();
        assertMode(AccountMode.NORMAL);
    }

    function test_TheSentinelCannotTouchTheFactory() public {
        vm.startPrank(sentinel);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.NotAdminOrGuardian.selector, sentinel));
        factory.clearExecutor();
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.NotAdminOrGuardian.selector, sentinel));
        factory.cancel(bytes32(0));
        vm.expectRevert();
        factory.propose(AccountFactoryV3.Action.SetSentinel, bytes32(uint256(uint160(sentinel))));
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
}
