// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {ExecutorV3} from "../../src/fund/ExecutorV3.sol";
import {RouteAdapter} from "../../src/fund/RouteAdapter.sol";
import {RiskTimelock} from "../../src/executor/RiskTimelock.sol";
import {IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
import {IExecutorFactoryV3, ReasonV3, SwapIntentV3} from "../../src/interfaces/IExecutorV3.sol";
import {IPoolRegistry, ITokenRegistry} from "../../src/interfaces/IFund.sol";
import {MockRouteAdapter} from "../mocks/ExecutorV3Mocks.sol";
import {ExecutorV3Base} from "./ExecutorV3Base.sol";

/// What a misbehaving venue, a stranger or a reentrant call can and cannot do
/// to Executor v3 (F-U4): the fill is judged by what arrived in the account,
/// never by what the venue reports; nothing stays with the Executor; only the
/// account mid-swap reaches `onSwap`; no native value; one binding.
contract ExecutorV3SafetyTest is ExecutorV3Base {
    function viaVenue(SwapIntentV3 memory i) internal pure returns (SwapIntentV3 memory) {
        i.adapterId = VENUE;
        return i;
    }

    function misbehave(MockRouteAdapter.Behaviour b) internal {
        venue.setBehaviour(b, "");
    }

    function assertUntouched() internal view {
        assertEq(usdcOf(address(account)), 700e6, "USDC untouched");
        assertEq(wmonOf(address(account)), 150e18, "WMON untouched");
        assertNothingKept();
    }

    function test_AnHonestVenueTradesThroughTheSameChecks() public {
        assertEq(submit(viaVenue(buy(10e6))), 5e18);
        assertEq(venue.calls(), 1);
        assertNothingKept();
    }

    function test_AVenueReportingMoreThanItDeliversIsRefusedByWhatArrived() public {
        misbehave(MockRouteAdapter.Behaviour.ReportMore);
        expectRejected(viaVenue(buy(10e6)), ReasonV3.SLIPPAGE_TOO_HIGH);
        assertUntouched();
    }

    function test_AVenuePayingLessIsRefused() public {
        misbehave(MockRouteAdapter.Behaviour.PayLess);
        expectRejected(viaVenue(buy(10e6)), ReasonV3.SLIPPAGE_TOO_HIGH);
        assertUntouched();
    }

    function test_AVenuePayingNothingIsRefused() public {
        misbehave(MockRouteAdapter.Behaviour.PayNothing);
        expectRejected(viaVenue(buy(10e6)), ReasonV3.SLIPPAGE_TOO_HIGH);
        assertUntouched();
    }

    function test_AVenuePayingElsewhereIsRefused() public {
        misbehave(MockRouteAdapter.Behaviour.PayElsewhere);
        expectRejected(viaVenue(buy(10e6)), ReasonV3.SLIPPAGE_TOO_HIGH);
        assertUntouched();
    }

    function test_AVenuePayingTheExecutorIsRefused() public {
        misbehave(MockRouteAdapter.Behaviour.PayTheExecutor);
        expectRejected(viaVenue(buy(10e6)), ReasonV3.SLIPPAGE_TOO_HIGH);
        assertUntouched();
    }

    function test_AVenuePayingAnotherTokenIsRefused() public {
        venue.setWrongToken(address(tokA));
        misbehave(MockRouteAdapter.Behaviour.PayWrongToken);
        expectRejected(viaVenue(buy(10e6)), ReasonV3.SLIPPAGE_TOO_HIGH);
        assertUntouched();
        assertEq(bal(address(tokA), address(account)), 0);
    }

    function test_AVenueRefundingHalfTheInputIsRefused() public {
        misbehave(MockRouteAdapter.Behaviour.RefundHalf);
        expectRejected(viaVenue(buy(10e6)), ReasonV3.SLIPPAGE_TOO_HIGH);
        assertUntouched();
    }

    function test_AFillOneUnitUnderTheMinimumIsRefused_AtTheMinimumItPasses() public {
        SwapIntentV3 memory i = viaVenue(buy(10e6));
        venue.setFixedOut(i.minAmountOut - 1);
        expectRejected(i, ReasonV3.SLIPPAGE_TOO_HIGH);
        venue.setFixedOut(i.minAmountOut);
        assertEq(submit(i), i.minAmountOut);
    }

    function test_AVenueCannotReenterTheExecutor() public {
        SwapIntentV3 memory inner = viaVenue(buy(10e6));
        venue.setBehaviour(MockRouteAdapter.Behaviour.ReenterExecutor, abi.encodeCall(ExecutorV3.swap, (inner)));
        SwapIntentV3 memory outer = viaVenue(buy(10e6));
        vm.prank(session);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        executor.swap(outer);
        assertUntouched();
    }

    function test_AVenueCannotCallOnSwap() public {
        SwapParamsV3 memory p;
        venue.setBehaviour(MockRouteAdapter.Behaviour.ReenterExecutor, abi.encodeCall(ExecutorV3.onSwap, (p)));
        SwapIntentV3 memory i = viaVenue(buy(10e6));
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.NotInSwap.selector, address(venue)));
        executor.swap(i);
        assertUntouched();
    }

    /// The account is mid-swap, so its own guard refuses the call before the owner check would.
    function test_AVenueCannotWithdrawFromTheAccount() public {
        misbehave(MockRouteAdapter.Behaviour.WithdrawFromTheAccount);
        SwapIntentV3 memory i = viaVenue(buy(10e6));
        vm.prank(session);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        executor.swap(i);
        assertUntouched();
        // Outside a swap, a stranger is refused as one.
        vm.prank(address(venue));
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, address(venue)));
        account.withdraw(address(usdc), 1, address(venue));
    }

    function test_OnlyTheAccountMidSwapCallsOnSwap() public {
        SwapParamsV3 memory p;
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.NotInSwap.selector, stranger));
        executor.onSwap(p);
        // The account itself, outside a swap: no context.
        vm.prank(address(account));
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.NotInSwap.selector, address(account)));
        executor.onSwap(p);
    }

    function test_OnlyTheExecutorCallsTheAccountsSwap() public {
        SwapParamsV3 memory p;
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotExecutor.selector, stranger));
        account.executeSwap(p);
    }

    function test_TheExecutorTakesNoNativeValue() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(executor).call{value: 1 ether}("");
        assertFalse(ok);
        SwapIntentV3 memory i = buy(10e6);
        vm.deal(session, 1 ether);
        vm.prank(session);
        (ok,) = address(executor).call{value: 1}(abi.encodeCall(ExecutorV3.swap, (i)));
        assertFalse(ok, "swap is not payable");
    }

    function test_OnlyTheExecutorCallsTheRouter() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RouteAdapter.NotExecutor.selector, stranger));
        router.swapRoute(address(usdc), address(wmon), 1, 1, stranger, _route(idUsdcWmon), false);
    }

    function test_BindsOnceToAFactoryThatNamesIt() public {
        vm.prank(admin);
        vm.expectRevert(ExecutorV3.AlreadyBound.selector);
        executor.bind(IExecutorFactoryV3(address(factory)), IPoolRegistry(address(pools)));
        ExecutorV3 other = new ExecutorV3(
            admin,
            guardian,
            IAgentNFTView(address(nft)),
            ITokenRegistry(address(tokens)),
            address(usdc),
            address(wmon),
            launchPolicy()
        );
        vm.prank(admin);
        vm.expectRevert(ExecutorV3.BadBinding.selector);
        other.bind(IExecutorFactoryV3(address(factory)), IPoolRegistry(address(pools)));
        vm.prank(admin);
        vm.expectRevert(ExecutorV3.BadBinding.selector);
        other.bind(IExecutorFactoryV3(address(0)), IPoolRegistry(address(pools)));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        other.bind(IExecutorFactoryV3(address(factory)), IPoolRegistry(address(pools)));
        // Unbound, it trades nothing.
        SwapIntentV3 memory i = buy(10e6);
        vm.prank(session);
        vm.expectRevert(ExecutorV3.NotBound.selector);
        other.swap(i);
    }

    function test_TheGuardianCannotLoosenOrRenounce() public {
        uint8 unpause = executor.UNPAUSE();
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        executor.propose(unpause, abi.encode(true));
        vm.prank(admin);
        vm.expectRevert(RiskTimelock.RenounceDisabled.selector);
        executor.renounceOwnership();
    }

    function test_AThreeHopTradeLeavesNothingAnywhereButTheAccount() public {
        deposit(address(tokA), 10e18);
        assertEq(submit(trade(address(tokA), address(tokB), 10e18)), 1.5e8);
        assertNothingKept();
        assertEq(bal(address(tokA), address(router)), 0);
        assertEq(bal(address(wmon), address(router)), 0);
        assertEq(bal(address(usdc), address(router)), 0);
        assertEq(bal(address(tokB), address(router)), 0);
    }
}
