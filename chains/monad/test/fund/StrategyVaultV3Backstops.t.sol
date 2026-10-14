// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
import {MockExecutorV3} from "../mocks/CustodyV3Mocks.sol";
import {StrategyVaultV3Base} from "./StrategyVaultV3Base.sol";

/// MV-S5 on the vault (P7-U2): the vault's own backstops catch a buggy or
/// compromised Executor, whatever it does inside `onSwap`, and the post-trade
/// checks hold at 12%, 45% and 1%, with depositors' shares untouched.
contract StrategyVaultV3BackstopsTest is StrategyVaultV3Base {
    function setUp() public override {
        super.setUp();
        threeDepositors();
        vaultBuys(address(tokA), 60e6);
        vaultBuys(address(tokB), 60e6);
        executor.setOtherToken(address(tokB));
    }

    function _expectSwapRevert(MockExecutorV3.Behaviour b, SwapParamsV3 memory p, bytes memory err) internal {
        executor.setBehaviour(b);
        vm.expectRevert(err);
        executor.swap(sv, p);
        executor.setBehaviour(MockExecutorV3.Behaviour.Honest);
    }

    function test_TheVaultCatchesAMisbehavingExecutor() public {
        SwapParamsV3 memory p = params(address(usdc), address(tokA), 30e6);
        uint256 supply = sv.totalSupply();
        _expectSwapRevert(
            MockExecutorV3.Behaviour.PullTwice, p, abi.encodeWithSelector(CustodyCoreV3.SwapContextInvalid.selector)
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.PullMore, p, abi.encodeWithSelector(CustodyCoreV3.SwapContextInvalid.selector)
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.PullOtherToken,
            p,
            abi.encodeWithSelector(CustodyCoreV3.SwapContextInvalid.selector)
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.PayNothing, p, abi.encodeWithSelector(CustodyCoreV3.OutputTooLow.selector, 0, 1)
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.PayWrongToken, p, abi.encodeWithSelector(CustodyCoreV3.OutputTooLow.selector, 0, 1)
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.PayLess,
            p,
            abi.encodeWithSelector(CustodyCoreV3.SlippageTooHigh.selector, 30e6, 15e6)
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.BurnOtherToken,
            p,
            abi.encodeWithSelector(CustodyCoreV3.OtherBalanceFell.selector, address(tokB))
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.ReenterExecute,
            p,
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        // A withdrawal from inside the swap is refused as the Executor's, not as the owner's.
        _expectSwapRevert(
            MockExecutorV3.Behaviour.ReenterWithdraw,
            p,
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(usdcBal(address(sv)), 180e6);
        assertEq(tokA.balanceOf(address(sv)), 10e18);
        assertEq(tokB.balanceOf(address(sv)), 1.5e8);
        assertEq(sv.totalSupply(), supply, "no misbehaviour touched a share");
    }

    function test_TheBackstopsHoldAtTheirThresholds() public {
        // CO-U1: 25% of 300 is 75: a 75.000001 USDC trade is refused.
        SwapParamsV3 memory over = params(address(usdc), address(tokA), 75e6 + 1);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.TradeTooLarge.selector, 75e6 + 1, 300e6));
        executor.swap(sv, over);
        executor.swap(sv, params(address(usdc), address(tokA), 75e6));
        // 60% by value: A at 135 of 300 now; 45 more reaches 60%, and 1 more passes it.
        SwapParamsV3 memory heavy = params(address(usdc), address(tokA), 45e6);
        executor.swap(sv, heavy);
        SwapParamsV3 memory tooHeavy = params(address(usdc), address(tokA), 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(CustodyCoreV3.ConcentrationTooHigh.selector, address(tokA), 180_999_999, 299_999_999)
        );
        executor.swap(sv, tooHeavy);
        // 2% against the reference prices on a sale.
        SwapParamsV3 memory sale = params(address(tokA), address(usdc), 5e18);
        executor.setOutputBps(9_800);
        executor.swap(sv, sale);
        executor.setOutputBps(9_799);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.SlippageTooHigh.selector, 30e6, 29.397e6));
        executor.swap(sv, sale);
    }

    /// Trading never moves value between depositors: every holder's slice of the
    /// value is the same share of the vault before and after a fair trade.
    function test_AFairTradeMovesNoValueBetweenDepositors() public {
        uint256 supply = sv.totalSupply();
        uint256 navBefore = sv.navUsdc();
        uint256 aliceBefore = sv.convertToAssets(sv.sharesOf(alice));
        executor.swap(sv, params(address(usdc), address(tokA), 30e6));
        executor.swap(sv, params(address(tokB), address(usdc), 0.5e8));
        assertEq(sv.totalSupply(), supply);
        assertEq(sv.navUsdc(), navBefore);
        assertEq(sv.convertToAssets(sv.sharesOf(alice)), aliceBefore);
    }
}
