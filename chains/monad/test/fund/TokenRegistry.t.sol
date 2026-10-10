// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {FeedConfig, FeedLeg, Lane, PriceClass, TokenRecord, TokenStatus} from "../../src/interfaces/IFund.sol";
import {LaneRegistry} from "../../src/fund/LaneRegistry.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {RiskTimelock} from "../../src/executor/RiskTimelock.sol";
import {MockToken} from "../mocks/CustodyMocks.sol";
import {RevertingAccount} from "../mocks/FundMocks.sol";
import {FundBase} from "./FundBase.sol";

/// The TokenRegistry's two lanes, its timelock and its instant tightening (F-U2, D-340 to D-342, D-351).
contract TokenRegistryTest is FundBase {
    MockToken internal meme;

    function setUp() public override {
        super.setUp();
        meme = new MockToken("MEME", 9);
    }

    function test_SeedsTheCoreLaneWithEachTokensOwnDecimalsAndFeed() public view {
        assertEq(tokens.tokenCount(), 5);
        TokenRecord memory b = tokens.tokenRecord(address(tokB));
        assertEq(uint8(b.lane), uint8(Lane.CORE));
        assertEq(uint8(b.status), uint8(TokenStatus.BUYABLE));
        assertEq(uint8(b.priceClass), uint8(PriceClass.F));
        assertEq(b.decimals, 8);
        FeedConfig memory f = tokens.feedOf(address(tokB));
        assertEq(f.rate.feed, address(bRate));
        assertEq(f.usd.maxAge, 300);
        assertEq(uint8(tokens.tokenRecord(address(tokC)).priceClass), uint8(PriceClass.A));
    }

    function test_RefusesACoreSeedWithAFeedThatIsNoContract() public {
        TokenRegistry.CoreSeed[] memory s = new TokenRegistry.CoreSeed[](1);
        s[0] = TokenRegistry.CoreSeed(
            address(meme), PriceClass.F, 1_000, FeedConfig(FeedLeg(address(0xdead), 8, 300), _noLeg())
        );
        vm.expectRevert(abi.encodeWithSelector(TokenRegistry.BadFeed.selector, address(meme)));
        new TokenRegistry(ADMIN, GUARDIAN, SCREENER, s);
    }

    // ---- the screened lane: instant, for opted-in personal accounts only ----

    function test_TheScreenerAddsAScreenedTokenAtOnceAsClassA() public {
        vm.prank(SCREENER);
        tokens.addScreened(address(meme), 800, keccak256("screen"), uint64(block.timestamp - 60));
        TokenRecord memory r = tokens.tokenRecord(address(meme));
        assertEq(uint8(r.lane), uint8(Lane.SCREENED));
        assertEq(uint8(r.priceClass), uint8(PriceClass.A));
        assertEq(r.decimals, 9);
        assertEq(r.maxPositionBps, 800);
        assertEq(r.screenHash, keccak256("screen"));
    }

    function test_OnlyTheScreenerAddsScreenedTokens() public {
        vm.prank(ADMIN);
        vm.expectRevert(abi.encodeWithSelector(LaneRegistry.NotScreener.selector, ADMIN));
        tokens.addScreened(address(meme), 800, bytes32(0), uint64(block.timestamp));
    }

    function test_AScreenOlderThanSixHoursOrFromTheFutureAddsNothing() public {
        uint64 old = uint64(block.timestamp - 6 hours - 1);
        vm.prank(SCREENER);
        vm.expectRevert(abi.encodeWithSelector(TokenRegistry.StaleScreen.selector, old));
        tokens.addScreened(address(meme), 800, bytes32(0), old);
        uint64 future = uint64(block.timestamp + 1);
        vm.prank(SCREENER);
        vm.expectRevert(abi.encodeWithSelector(TokenRegistry.StaleScreen.selector, future));
        tokens.addScreened(address(meme), 800, bytes32(0), future);
    }

    function test_AScreenedCapIsBoundedByTheClassAMaximum() public {
        vm.prank(SCREENER);
        vm.expectRevert(abi.encodeWithSelector(TokenRegistry.BadCap.selector, uint16(1_501)));
        tokens.addScreened(address(meme), 1_501, bytes32(0), uint64(block.timestamp));
    }

    function test_ScreenedTokensAreBuyableOnlyByOptedInPersonalAccounts() public {
        vm.prank(SCREENER);
        tokens.addScreened(address(meme), 800, bytes32(0), uint64(block.timestamp));
        assertTrue(tokens.buyableFor(address(meme), address(optedIn)));
        assertFalse(tokens.buyableFor(address(meme), address(notOptedIn)));
        assertFalse(tokens.buyableFor(address(meme), address(vault)), "a vault never holds screened tokens");
        assertFalse(tokens.buyableFor(address(meme), OWNER_ACCOUNT_EOA), "an EOA is no account");
        assertFalse(tokens.buyableFor(address(meme), address(new RevertingAccount())));
        // Core tokens: every account.
        assertTrue(tokens.buyableFor(address(tokA), address(notOptedIn)));
        assertTrue(tokens.buyableFor(address(tokA), address(vault)));
    }

    // ---- the core lane: the timelock ----

    function test_ACoreTokenWaitsTheNineDayTimelock() public {
        bytes memory data =
            abi.encode(TokenRegistry.CoreSeed(address(meme), PriceClass.A, 1_000, FeedConfig(_noLeg(), _noLeg())));
        uint8 addCore = tokens.ADD_CORE();
        vm.prank(ADMIN);
        tokens.propose(addCore, data);
        vm.warp(block.timestamp + 9 days - 1);
        vm.expectRevert();
        tokens.execute(addCore, data);
        vm.warp(block.timestamp + 1);
        tokens.execute(addCore, data);
        assertEq(uint8(tokens.tokenRecord(address(meme)).lane), uint8(Lane.CORE));
    }

    function test_OnlyTheAdminProposes() public {
        uint8 addCore = tokens.ADD_CORE();
        vm.prank(SCREENER);
        vm.expectRevert();
        tokens.propose(addCore, "");
    }

    function test_MakingAnAddressTheScreenerWaitsTheTimelock() public {
        bytes memory data = abi.encode(address(0x1234));
        uint8 setScreener = tokens.SET_SCREENER();
        vm.prank(ADMIN);
        tokens.propose(setScreener, data);
        assertEq(tokens.screener(), SCREENER);
        vm.warp(block.timestamp + 9 days);
        tokens.execute(setScreener, data);
        assertEq(tokens.screener(), address(0x1234));
    }

    // ---- sell-only and frozen: instant tightening, timelocked loosening ----

    function test_TheScreenerTheGuardianAndTheAdminTightenAtOnce() public {
        vm.prank(SCREENER);
        tokens.setSellOnly(address(tokA));
        assertEq(uint8(tokens.tokenRecord(address(tokA)).status), uint8(TokenStatus.SELL_ONLY));
        assertFalse(tokens.buyableFor(address(tokA), address(optedIn)));
        assertTrue(tokens.sellable(address(tokA)));
        vm.prank(GUARDIAN);
        tokens.freeze(address(tokA));
        assertFalse(tokens.sellable(address(tokA)));
        vm.prank(ADMIN);
        tokens.setSellOnly(address(tokB));
    }

    function test_AStrangerCannotTighten() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(LaneRegistry.NotTightener.selector, address(0xBAD)));
        tokens.setSellOnly(address(tokA));
    }

    function test_NothingBecomesBuyableAtOnce() public {
        vm.prank(GUARDIAN);
        tokens.freeze(address(tokA));
        // Frozen to sell-only is a loosening: refused at once.
        vm.prank(SCREENER);
        vm.expectRevert(
            abi.encodeWithSelector(TokenRegistry.NotStricter.selector, TokenStatus.FROZEN, TokenStatus.SELL_ONLY)
        );
        tokens.setSellOnly(address(tokA));
        // A frozen token cannot come back through the screened lane either.
        vm.prank(SCREENER);
        vm.expectRevert(abi.encodeWithSelector(TokenRegistry.AlreadyRegistered.selector, address(tokA)));
        tokens.addScreened(address(tokA), 800, bytes32(0), uint64(block.timestamp));
        // Restoring waits the timelock.
        bytes memory data = abi.encode(address(tokA), TokenStatus.BUYABLE);
        uint8 restore = tokens.RESTORE();
        vm.prank(ADMIN);
        tokens.propose(restore, data);
        vm.warp(block.timestamp + 9 days);
        tokens.execute(restore, data);
        assertTrue(tokens.buyableFor(address(tokA), address(notOptedIn)));
    }

    function test_ARestoreMustLoosen() public {
        uint8 restore = tokens.RESTORE();
        vm.prank(ADMIN);
        vm.expectRevert(
            abi.encodeWithSelector(TokenRegistry.NotLooser.selector, TokenStatus.BUYABLE, TokenStatus.FROZEN)
        );
        tokens.propose(restore, abi.encode(address(tokA), TokenStatus.FROZEN));
    }

    function test_TheGuardianCancelsAPendingLoosening() public {
        vm.prank(SCREENER);
        tokens.setSellOnly(address(tokA));
        bytes memory data = abi.encode(address(tokA), TokenStatus.BUYABLE);
        uint8 restore = tokens.RESTORE();
        vm.prank(ADMIN);
        bytes32 id = tokens.propose(restore, data);
        vm.prank(GUARDIAN);
        tokens.cancel(id);
        vm.warp(block.timestamp + 9 days);
        vm.expectRevert(abi.encodeWithSelector(RiskTimelock.NotPending.selector, id));
        tokens.execute(restore, data);
    }

    // ---- caps, screens, promotion and feeds ----

    function test_LoweringACapIsInstantAndRaisingItWaits() public {
        vm.prank(GUARDIAN);
        tokens.lowerCap(address(tokA), 1_000);
        assertEq(tokens.tokenRecord(address(tokA)).maxPositionBps, 1_000);
        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(TokenRegistry.BadCap.selector, uint16(2_000)));
        tokens.lowerCap(address(tokA), 2_000);
        bytes memory data = abi.encode(address(tokA), uint16(2_000));
        uint8 setCap = tokens.SET_CAP();
        vm.prank(ADMIN);
        tokens.propose(setCap, data);
        vm.warp(block.timestamp + 9 days);
        tokens.execute(setCap, data);
        assertEq(tokens.tokenRecord(address(tokA)).maxPositionBps, 2_000);
    }

    function test_TheScreenerRecordsANewerScreenWithoutChangingStatus() public {
        vm.prank(SCREENER);
        tokens.setSellOnly(address(tokA));
        vm.prank(SCREENER);
        tokens.recordScreen(address(tokA), keccak256("rescreen"), uint64(block.timestamp));
        TokenRecord memory r = tokens.tokenRecord(address(tokA));
        assertEq(r.screenHash, keccak256("rescreen"));
        assertEq(uint8(r.status), uint8(TokenStatus.SELL_ONLY));
    }

    function test_PromotingAScreenedTokenToCoreWithAFeedWaitsTheTimelock() public {
        vm.prank(SCREENER);
        tokens.addScreened(address(meme), 800, bytes32(0), uint64(block.timestamp));
        bytes memory data = abi.encode(address(meme), PriceClass.F, FeedConfig(_feed(aUsd, 8, 3_900), _noLeg()));
        uint8 promote = tokens.PROMOTE();
        vm.prank(ADMIN);
        tokens.propose(promote, data);
        vm.warp(block.timestamp + 9 days);
        tokens.execute(promote, data);
        TokenRecord memory r = tokens.tokenRecord(address(meme));
        assertEq(uint8(r.lane), uint8(Lane.CORE));
        assertEq(uint8(r.priceClass), uint8(PriceClass.F));
        assertEq(tokens.feedOf(address(meme)).usd.feed, address(aUsd));
    }

    function test_TheRegistryIsBounded() public {
        for (uint256 i = tokens.tokenCount(); i < tokens.MAX_TOKENS(); ++i) {
            MockToken t = new MockToken("T", 18);
            vm.prank(SCREENER);
            tokens.addScreened(address(t), 100, bytes32(0), uint64(block.timestamp));
        }
        MockToken extra = new MockToken("X", 18);
        vm.prank(SCREENER);
        vm.expectRevert(TokenRegistry.TooManyTokens.selector);
        tokens.addScreened(address(extra), 100, bytes32(0), uint64(block.timestamp));
    }

    function test_AdminCannotBeRenounced() public {
        vm.prank(ADMIN);
        vm.expectRevert(RiskTimelock.RenounceDisabled.selector);
        tokens.renounceOwnership();
    }
}
