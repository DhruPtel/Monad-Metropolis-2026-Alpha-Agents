// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ExecutorV3} from "../../src/fund/ExecutorV3.sol";
import {ReasonV3, SwapIntentV3} from "../../src/interfaces/IExecutorV3.sol";
import {ExecutorV3Base} from "./ExecutorV3Base.sol";

/// Session grants and epochs in Executor v3 (F-U4), as in v2: the owner names
/// one key per agent for at most 30 days; a sale of the agent or a change of
/// its configuration ends the grant, which never revives; the trade counter
/// survives both.
contract ExecutorV3SessionsTest is ExecutorV3Base {
    function test_AnUnknownKeyIsRefused() public {
        SwapIntentV3 memory i = buy(10e6);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.SESSION_UNKNOWN));
        executor.swap(i);
        vm.prank(owner);
        executor.revokeSession(AGENT);
        expectRejected(buy(10e6), ReasonV3.SESSION_UNKNOWN);
    }

    function test_AGrantIsValidUntilItsExpiry_ThenRefused() public {
        uint64 until = uint64(block.timestamp + 1 days);
        grant(until);
        ExecutorV3.Grant memory g = executor.sessionOf(AGENT);
        assertEq(g.key, session);
        assertEq(g.validUntil, until);
        vm.warp(until);
        _refreshFeeds();
        submit(buy(10e6));
        vm.warp(until + 1);
        _refreshFeeds();
        expectRejected(buy(10e6), ReasonV3.SESSION_EXPIRED);
    }

    function test_OnlyTheOwnerRegistersOrRevokes_WithinThirtyDays() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.NotAgentOwner.selector, stranger));
        executor.registerSession(AGENT, stranger, uint64(block.timestamp + 1 days));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.NotAgentOwner.selector, stranger));
        executor.revokeSession(AGENT);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.NotAgentOwner.selector, stranger));
        executor.bumpConfigEpoch(AGENT);
        vm.startPrank(owner);
        vm.expectRevert(ExecutorV3.BadSession.selector);
        executor.registerSession(AGENT, session, uint64(block.timestamp + 30 days + 1));
        vm.expectRevert(ExecutorV3.BadSession.selector);
        executor.registerSession(AGENT, session, uint64(block.timestamp));
        vm.expectRevert(ExecutorV3.BadSession.selector);
        executor.registerSession(AGENT, address(0), uint64(block.timestamp + 1 days));
        executor.registerSession(AGENT, session, uint64(block.timestamp + 30 days));
        vm.stopPrank();
        submit(buy(10e6));
    }

    function test_ASaleOfTheAgentEndsTheGrant() public {
        nft.setOwner(AGENT, stranger);
        expectRejected(buy(10e6), ReasonV3.EPOCH_MISMATCH);
        // An intent still naming the old epoch is refused the same way.
        SwapIntentV3 memory i = buy(10e6);
        i.ownerEpoch = 0;
        expectRejected(i, ReasonV3.EPOCH_MISMATCH);
    }

    function test_AGrantNeverRevivesWhenTheAgentReturnsToAFormerOwner() public {
        nft.setOwner(AGENT, stranger);
        nft.setOwner(AGENT, owner);
        assertEq(nft.ownerEpoch(AGENT), 2);
        expectRejected(buy(10e6), ReasonV3.EPOCH_MISMATCH);
        grant(uint64(block.timestamp + 7 days));
        submit(buy(10e6));
    }

    function test_AConfigurationChangeEndsTheGrant() public {
        vm.prank(owner);
        executor.bumpConfigEpoch(AGENT);
        assertEq(executor.configEpochOf(AGENT), 1);
        expectRejected(buy(10e6), ReasonV3.EPOCH_MISMATCH);
        SwapIntentV3 memory i = buy(10e6);
        i.configEpoch = 0;
        expectRejected(i, ReasonV3.EPOCH_MISMATCH);
        grant(uint64(block.timestamp + 7 days));
        submit(buy(10e6));
    }

    function test_TheTradeCounterSurvivesEpochChanges() public {
        submit(buy(10e6));
        submit(sell(5e18));
        vm.prank(owner);
        executor.bumpConfigEpoch(AGENT);
        nft.setOwner(AGENT, stranger);
        nft.setOwner(AGENT, owner);
        grant(uint64(block.timestamp + 7 days));
        (, uint256 left,, uint256 used) = executor.limits(address(account));
        assertEq(left, 18);
        assertEq(used, 20e6);
    }

    function test_AnotherAgentsKeyCannotTradeThisAccount() public {
        address otherKey = makeAddr("other key");
        nft.setOwner(8, stranger);
        vm.prank(stranger);
        executor.registerSession(8, otherKey, uint64(block.timestamp + 1 days));
        SwapIntentV3 memory i = buy(10e6);
        i.agentId = 8;
        vm.prank(otherKey);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.INTENT_INVALID));
        executor.swap(i);
        i = buy(10e6);
        vm.prank(otherKey);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.SESSION_UNKNOWN));
        executor.swap(i);
    }
}
