// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CustodyCore} from "../../src/custody/CustodyCore.sol";
import {Executor} from "../../src/executor/Executor.sol";
import {SwapParams} from "../../src/interfaces/ICustody.sol";
import {SwapIntent} from "../../src/interfaces/IExecutor.sol";
import {MockVenue} from "../mocks/ExecutorMocks.sol";
import {ExecutorBase} from "./ExecutorBase.sol";

/// No intent and no venue can move funds anywhere but the source account, or
/// leave an allowance (P2-U2): every way a venue could misbehave reverts the
/// whole trade, and nothing reenters.
contract ExecutorSafetyTest is ExecutorBase {
    function behave(MockVenue.Behaviour b, bytes memory reentry) internal {
        venue.setBehaviour(b, reentry);
    }

    function expectNothingMoved() internal view {
        assertEq(usdcOf(address(account)), 70e6);
        assertEq(wmonOf(address(account)), 30e18);
        assertEq(usdcOf(address(executor)) + wmonOf(address(executor)), 0);
    }

    function test_AVenuePayingElsewhereIsRefusedByTheAccount() public {
        behave(MockVenue.Behaviour.PayElsewhere, "");
        SwapIntent memory i = sell(1e18);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.OutputTooLow.selector, 0, i.minAmountOut));
        executor.swap(i);
        expectNothingMoved();
    }

    function test_AVenuePayingTheExecutorIsRefused() public {
        behave(MockVenue.Behaviour.PayTheExecutor, "");
        SwapIntent memory i = sell(1e18);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(Executor.ExecutorKeptFunds.selector, address(usdc)));
        executor.swap(i);
        expectNothingMoved();
    }

    function test_AVenuePayingLessIsRefused() public {
        behave(MockVenue.Behaviour.PayLess, "");
        SwapIntent memory i = sell(1e18);
        vm.prank(session);
        vm.expectRevert();
        executor.swap(i);
        expectNothingMoved();
    }

    function test_AVenueLeavingAnAllowanceIsRefused() public {
        behave(MockVenue.Behaviour.LeaveAllowance, "");
        SwapIntent memory i = sell(1e18);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(Executor.AllowanceLeft.selector, address(wmon)));
        executor.swap(i);
        expectNothingMoved();
    }

    function test_AVenueCannotReenterTheExecutor() public {
        SwapIntent memory inner = sell(2e18);
        behave(MockVenue.Behaviour.ReenterExecutor, abi.encodeCall(Executor.swap, (inner)));
        SwapIntent memory i = sell(1e18);
        vm.prank(session);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        executor.swap(i);
        expectNothingMoved();
    }

    function test_AVenueCannotWithdrawFromTheAccount() public {
        behave(MockVenue.Behaviour.WithdrawFromTheAccount, "");
        SwapIntent memory i = sell(1e18);
        vm.prank(session);
        vm.expectRevert(); // the account's own guard and owner check
        executor.swap(i);
        expectNothingMoved();
    }

    function test_UnusedInputGoesBackToTheAccount() public {
        behave(MockVenue.Behaviour.RefundHalf, "");
        submit(sell(2e18));
        assertEq(wmonOf(address(account)), 29e18, "half the input came back");
        assertEq(usdcOf(address(account)), 72e6);
    }

    function test_OnlyTheAccountMidSwapCallsOnSwap() public {
        SwapParams memory p;
        vm.expectRevert(abi.encodeWithSelector(Executor.NotInSwap.selector, address(this)));
        executor.onSwap(p);
        vm.prank(address(account));
        vm.expectRevert(abi.encodeWithSelector(Executor.NotInSwap.selector, address(account)));
        executor.onSwap(p);
    }

    function test_TheExecutorTakesNoNativeValue() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(executor).call{value: 1 ether}("");
        assertFalse(ok);
        SwapIntent memory i = sell(1e18);
        vm.deal(session, 1 ether);
        vm.prank(session);
        (ok,) = address(executor).call{value: 1}(abi.encodeCall(Executor.swap, (i)));
        assertFalse(ok, "swap is not payable");
    }

    function test_OnlyTheExecutorCallsTheVenue() public {
        vm.expectRevert("not the executor");
        venue.swap(address(usdc), address(wmon), 1, 1, address(this));
    }
}
