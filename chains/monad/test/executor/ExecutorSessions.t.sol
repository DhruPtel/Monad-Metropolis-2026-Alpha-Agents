// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Executor} from "../../src/executor/Executor.sol";
import {ProtocolRegistry} from "../../src/executor/ProtocolRegistry.sol";
import {RiskTimelock} from "../../src/executor/RiskTimelock.sol";
import {IExecutorFactory, Reason, SwapIntent} from "../../src/interfaces/IExecutor.sol";
import {ExecutorBase} from "./ExecutorBase.sol";

/// Session grants and epochs (FINAL_PLAN 4.1.7): only the registered key,
/// only until expiry, only under the epochs the grant was made in; and a
/// grant never comes back when the agent returns to a former owner.
contract ExecutorSessionsTest is ExecutorBase {
    function test_AnUnknownKeyIsRefused() public {
        SwapIntent memory i = sell(1e18);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Executor.Rejected.selector, Reason.SESSION_UNKNOWN));
        executor.swap(i);
        vm.prank(owner); // not even the owner: only the session key submits
        vm.expectRevert(abi.encodeWithSelector(Executor.Rejected.selector, Reason.SESSION_UNKNOWN));
        executor.swap(i);
    }

    function test_AGrantIsValidUntilItsExpiry_ThenRefused() public {
        uint64 until = uint64(block.timestamp + 1 hours);
        grant(until);
        vm.warp(until);
        setMon(ONE_DOLLAR);
        submit(sell(1e18));
        vm.warp(until + 1);
        setMon(ONE_DOLLAR);
        expectRejected(sell(1e18), Reason.SESSION_EXPIRED);
    }

    function test_OnlyTheOwnerRegistersOrRevokes_WithinThirtyDays() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Executor.NotAgentOwner.selector, stranger));
        executor.registerSession(AGENT, stranger, uint64(block.timestamp + 1 days));
        uint256 tooLong = block.timestamp + 30 days + 1;
        vm.prank(owner);
        vm.expectRevert(Executor.BadSession.selector);
        executor.registerSession(AGENT, session, uint64(tooLong));
        vm.prank(owner);
        vm.expectRevert(Executor.BadSession.selector);
        executor.registerSession(AGENT, address(0), uint64(block.timestamp + 1 days));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Executor.NotAgentOwner.selector, stranger));
        executor.revokeSession(AGENT);
        vm.prank(owner);
        executor.revokeSession(AGENT);
        expectRejected(sell(1e18), Reason.SESSION_UNKNOWN);
    }

    function test_ASaleOfTheAgentEndsTheGrant() public {
        SwapIntent memory signedBefore = sell(1e18);
        address buyer = makeAddr("buyer");
        nft.setOwner(AGENT, buyer);
        // The old intent and the old grant both carry the old ownership epoch.
        expectRejected(signedBefore, Reason.EPOCH_MISMATCH);
        expectRejected(sell(1e18), Reason.EPOCH_MISMATCH);
    }

    function test_AGrantNeverRevivesWhenTheAgentReturnsToAFormerOwner() public {
        address buyer = makeAddr("buyer");
        nft.setOwner(AGENT, buyer);
        nft.setOwner(AGENT, owner);
        // Same owner, same key, but the epoch moved on twice.
        expectRejected(sell(1e18), Reason.EPOCH_MISMATCH);
        grant(uint64(block.timestamp + 1 days));
        submit(sell(1e18));
    }

    function test_AConfigurationChangeEndsTheGrant() public {
        SwapIntent memory signedBefore = sell(1e18);
        vm.prank(owner);
        executor.bumpConfigEpoch(AGENT);
        expectRejected(signedBefore, Reason.EPOCH_MISMATCH);
        expectRejected(sell(1e18), Reason.EPOCH_MISMATCH);
        grant(uint64(block.timestamp + 1 days));
        submit(sell(1e18));
    }

    function test_TheTradeCounterSurvivesEpochChanges() public {
        for (uint256 k = 0; k < 20; ++k) {
            submit(sell(1e18));
        }
        vm.prank(owner);
        executor.bumpConfigEpoch(AGENT);
        grant(uint64(block.timestamp + 1 days));
        expectRejected(sell(1e18), Reason.DAILY_TRADE_LIMIT);
    }

    function test_AnotherAgentsKeyCannotTradeThisAccount() public {
        nft.setOwner(8, stranger);
        vm.prank(stranger);
        executor.registerSession(8, stranger, uint64(block.timestamp + 1 days));
        SwapIntent memory i = sell(1e18);
        i.agentId = 8;
        i.ownerEpoch = nft.ownerEpoch(8);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Executor.Rejected.selector, Reason.INTENT_INVALID));
        executor.swap(i);
    }

    function test_BindsOnceToAFactoryThatNamesIt() public {
        vm.prank(admin);
        vm.expectRevert(Executor.AlreadyBound.selector);
        executor.bind(IExecutorFactory(address(factory)), registry);
        Executor fresh = new Executor(admin, guardian, nft, address(usdc), address(wmon), launchPolicy());
        vm.prank(admin);
        vm.expectRevert(Executor.BadBinding.selector);
        fresh.bind(IExecutorFactory(address(factory)), registry);
        vm.prank(stranger);
        vm.expectRevert();
        fresh.bind(IExecutorFactory(address(factory)), registry);
    }

    function test_TheGuardianCannotLoosenOrRenounce() public {
        bytes memory data = abi.encode(stranger);
        uint8 setGuardian = executor.SET_GUARDIAN();
        vm.prank(guardian);
        vm.expectRevert();
        executor.propose(setGuardian, data);
        vm.prank(admin);
        vm.expectRevert(RiskTimelock.RenounceDisabled.selector);
        executor.renounceOwnership();
        vm.prank(admin);
        bytes32 id = executor.propose(setGuardian, data);
        vm.prank(guardian);
        executor.cancel(id);
        vm.warp(block.timestamp + 9 days);
        vm.expectRevert(abi.encodeWithSelector(RiskTimelock.NotPending.selector, id));
        executor.execute(setGuardian, data);
    }

    // ----- the registry -----

    function test_AnUnknownOrPausedVenueIsRefused() public {
        SwapIntent memory i = sell(1e18);
        i.adapterId = keccak256("no such venue");
        expectRejected(i, Reason.VENUE_NOT_ALLOWED);
        vm.prank(guardian);
        registry.pause(VENUE);
        expectRejected(sell(1e18), Reason.VENUE_NOT_ALLOWED);
    }

    function test_AnExitOnlyVenueOnlySellsIntoUsdc() public {
        vm.prank(guardian);
        registry.setExitOnly(VENUE);
        expectRejected(buy(1e6), Reason.VENUE_NOT_ALLOWED);
        submit(sell(1e18));
    }

    function test_AVenueWhoseCodeChangedIsRefused() public {
        vm.etch(address(venue), hex"00");
        expectRejected(sell(1e18), Reason.VENUE_NOT_ALLOWED);
    }

    function test_RegisteringOrActivatingAVenueWaitsTheTimelock() public {
        vm.prank(guardian);
        registry.pause(VENUE);
        bytes memory data = abi.encode(VENUE);
        uint8 activate = registry.ACTIVATE();
        vm.prank(admin);
        bytes32 id = registry.propose(activate, data);
        (uint64 at,) = registry.pending(id);
        vm.expectRevert(abi.encodeWithSelector(RiskTimelock.TooEarly.selector, at));
        registry.execute(activate, data);
        vm.warp(block.timestamp + 9 days);
        registry.execute(activate, data);
        assertEq(uint8(registry.entry(VENUE).status), uint8(ProtocolRegistry.Status.ACTIVE));
        // Pausing never needed the timelock, and the guardian cannot set exit-only on a paused venue.
        vm.prank(guardian);
        registry.pause(VENUE);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistry.BadStatus.selector, ProtocolRegistry.Status.PAUSED));
        registry.setExitOnly(VENUE);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RiskTimelock.NotAdminOrGuardian.selector, stranger));
        registry.pause(VENUE);
    }
}
