// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Executor} from "../../src/executor/Executor.sol";
import {IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {Policy, Reason, SwapIntent} from "../../src/interfaces/IExecutor.sol";
import {ExecutorBase} from "./ExecutorBase.sol";

/// The Executor with a way to write its ring buffer, so a case can start with
/// past trades. Every check is the real Executor's.
contract ExecutorHarness is Executor {
    constructor(address admin, address guardian_, IAgentNFTView nft, address usdc, address wmon, Policy memory p)
        Executor(admin, guardian_, nft, usdc, wmon, p)
    {}

    function seedTrade(address account, uint256 slot, uint64 at, uint192 value) external {
        _rings[account].trades[slot] = PastTrade(at, value);
    }
}

/// packages/policy's executorVerdict wrote down what it answers for each case
/// (packages/policy/fixtures/executor-parity.json); this replays every case on
/// the real Executor, account and oracle adapter, and requires the same
/// answer. packages/policy's parity test fails if the fixture is not what its
/// code answers now, so a change to either side alone fails one of them.
contract ExecutorParityTest is ExecutorBase {
    struct Case {
        string name;
        uint256 usdc;
        uint256 wmon;
        uint256 peakAnswer;
        uint256 answer;
        uint256 feedAge;
        uint256 sqrtPriceX96;
        uint256 mode;
        bool paused;
        bool buyable;
        bool venueAllowed;
        uint256[] tradeAges;
        uint256[] tradeValues;
        string tokenIn;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 deadline;
        uint256 amountOut;
        uint256 reason;
        uint256 navAfter;
        uint256 drawdownBps;
    }

    string internal constant CASE_TYPE =
        "Case(string name,uint256 usdc,uint256 wmon,uint256 peakAnswer,uint256 answer,uint256 feedAge,uint256 sqrtPriceX96,uint256 mode,bool paused,bool buyable,bool venueAllowed,uint256[] tradeAges,uint256[] tradeValues,string tokenIn,uint256 amountIn,uint256 minAmountOut,uint256 deadline,uint256 amountOut,uint256 reason,uint256 navAfter,uint256 drawdownBps)";

    string internal json;

    function newExecutor(Policy memory p) internal override returns (Executor) {
        return new ExecutorHarness(admin, guardian, IAgentNFTView(address(nft)), address(usdc), address(wmon), p);
    }

    function setUp() public override {
        fundOnBuild = false;
        super.setUp();
        json = vm.readFile("../../packages/policy/fixtures/executor-parity.json");
    }

    function test_TheFixtureUsesTheLaunchPolicy() public view {
        assertEq(vm.parseJsonBytes32(json, ".policyHash"), executor.policyHash());
        assertEq(vm.parseJsonUint(json, ".t0"), block.timestamp);
    }

    function test_TheExecutorMatchesThePolicyPackage() public {
        Case[] memory cases = abi.decode(vm.parseJsonTypeArray(json, ".cases", CASE_TYPE), (Case[]));
        assertEq(cases.length, vm.parseJsonUint(json, ".caseCount"));
        uint256 fee = vm.parseJsonUint(json, ".venueFeeBps");
        uint256 start = vm.snapshotState();
        for (uint256 k = 0; k < cases.length; ++k) {
            _replay(cases[k], fee);
            vm.revertToState(start);
        }
    }

    function _replay(Case memory c, uint256 fee) internal {
        // Deposits and a poke at the peak price, with fresh feeds.
        setMon(int256(c.peakAnswer));
        fund(c.usdc, c.wmon);
        account.poke();
        // Then the market the case describes.
        monFeed.setRound(77, int256(c.answer), block.timestamp - c.feedAge, 77);
        // forge-lint: disable-next-line(unsafe-typecast)
        stateView.setSqrtPrice(uint160(c.sqrtPriceX96));
        if (c.mode == 1) {
            vm.prank(sentinel);
            account.setReduceOnly();
        } else if (c.mode == 2) {
            vm.prank(sentinel);
            account.pause();
        }
        if (c.paused) {
            vm.prank(guardian);
            executor.pauseAll();
        }
        if (!c.buyable) {
            vm.prank(admin);
            factory.removeBuyable(address(wmon));
        }
        if (!c.venueAllowed) {
            vm.prank(guardian);
            registry.pause(VENUE);
        }
        for (uint256 j = 0; j < c.tradeAges.length; ++j) {
            // forge-lint: disable-next-line(unsafe-typecast)
            ExecutorHarness(address(executor))
                .seedTrade(address(account), j, uint64(block.timestamp - c.tradeAges[j]), uint192(c.tradeValues[j]));
        }
        venue.setFixedOut(c.amountOut);
        venue.setFeeBps(fee);

        bool buy = keccak256(bytes(c.tokenIn)) == keccak256("USDC");
        SwapIntent memory i = intent(
            buy ? address(usdc) : address(wmon), buy ? address(wmon) : address(usdc), c.amountIn, c.minAmountOut
        );
        // forge-lint: disable-next-line(unsafe-typecast)
        i.deadline = uint64(c.deadline);
        (,,, uint256 drawdown) = _drawdown();
        vm.prank(session);
        try executor.swap(i) returns (uint256 out) {
            assertEq(c.reason, 255, string.concat(c.name, ": the policy package refused it"));
            assertEq(out, c.amountOut, string.concat(c.name, ": amount out"));
            uint256 px = uint256(c.answer) * 1e10;
            uint256 navAfter = account.freeBalance(address(usdc)) + account.freeBalance(address(wmon)) * px / 1e30;
            assertEq(navAfter, c.navAfter, string.concat(c.name, ": NAV after"));
        } catch (bytes memory why) {
            assertEq(bytes4(why), Executor.Rejected.selector, string.concat(c.name, ": not a Rejected"));
            Reason r;
            assembly {
                r := mload(add(why, 36))
            }
            assertEq(uint256(r), c.reason, string.concat(c.name, ": reason"));
        }
        if (drawdown != type(uint256).max) assertEq(drawdown, c.drawdownBps, string.concat(c.name, ": drawdown"));
    }

    /// The account's drawdown when its prices are usable, or max when they are not.
    function _drawdown() internal view returns (uint256 nav, uint256 perUnit, uint256 peak, uint256 drawdown) {
        try account.breakerState() returns (uint256 n, uint256 p, uint256 pk, uint256 d) {
            return (n, p, pk, d);
        } catch {
            return (0, 0, 0, type(uint256).max);
        }
    }
}
