// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
import {MockToken, OwnerWallet, ReentrantToken} from "../mocks/CustodyMocks.sol";
import {CustodyV3Base} from "./CustodyV3Base.sol";

/// Reentrancy (F-U3): the owner itself, a contract, calls back into the
/// account while a withdrawal, credit claim or deposit is moving tokens, USDC
/// being a token with receiver hooks. Every entry point is refused by the
/// guard, and the balances come out exactly right.
contract CustodyV3ReentrancyTest is CustodyV3Base {
    ReentrantToken internal hooked;
    OwnerWallet internal wallet;

    function _newUsdc() internal override returns (MockToken) {
        hooked = new ReentrantToken();
        return hooked;
    }

    function _makeOwner() internal override returns (address) {
        wallet = new OwnerWallet();
        return address(wallet);
    }

    function setUp() public override {
        super.setUp();
        hooked.mint(address(wallet), 50e6);
        wallet.exec(address(hooked), abi.encodeCall(hooked.approve, (address(account), type(uint256).max)));
        wallet.exec(address(account), abi.encodeCall(PersonalAccountV3.deposit, (address(hooked), 50e6)));
    }

    /// Every guarded state-changing entry point, as the owner would call it.
    function payloads() internal view returns (bytes[] memory p) {
        SwapParamsV3 memory s;
        p = new bytes[](9);
        p[0] = abi.encodeCall(CustodyCoreV3.withdraw, (address(hooked), 1e6, address(wallet)));
        p[1] = abi.encodeCall(CustodyCoreV3.withdrawAll, (address(wallet)));
        p[2] = abi.encodeCall(CustodyCoreV3.claim, (address(hooked), address(wallet)));
        p[3] = abi.encodeCall(PersonalAccountV3.deposit, (address(hooked), 1e6));
        p[4] = abi.encodeCall(CustodyCoreV3.executeSwap, (s));
        p[5] = abi.encodeWithSignature("poke()");
        p[6] = abi.encodeWithSignature("poke(address[],bytes[])", new address[](0), new bytes[](0));
        p[7] = abi.encodeCall(CustodyCoreV3.pullForSwap, (address(hooked), 1e6));
        p[8] = abi.encodeCall(PersonalAccountV3.initialize, (1, address(this)));
        return p;
    }

    function assertRefused(uint256 i) internal view {
        assertFalse(hooked.lastCallSucceeded(), "a reentrant call succeeded");
        bytes memory reason = hooked.lastRevert();
        bytes4 selector = bytes4(reason);
        if (i <= 6) assertEq(selector, ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        else if (i == 7) assertEq(selector, CustodyCoreV3.SwapContextInvalid.selector);
        else assertEq(selector, PersonalAccountV3.AlreadyInitialized.selector);
    }

    function test_NothingReentersAWithdrawal() public {
        bytes[] memory p = payloads();
        for (uint256 i = 0; i < p.length; i++) {
            hooked.arm(wallet, address(account), p[i]);
            wallet.exec(
                address(account), abi.encodeCall(CustodyCoreV3.withdraw, (address(hooked), 1e6, address(wallet)))
            );
            assertRefused(i);
        }
        assertEq(hooked.balanceOf(address(account)), 50e6 - 9e6);
        assertEq(hooked.balanceOf(address(wallet)), 9e6);
    }

    function test_NothingReentersAWithdrawAllOrAClaim() public {
        bytes[] memory p = payloads();
        hooked.arm(wallet, address(account), p[0]);
        wallet.exec(address(account), abi.encodeCall(CustodyCoreV3.withdrawAll, (address(wallet))));
        assertRefused(0);
        assertEq(hooked.balanceOf(address(wallet)), 50e6);

        // A credit, then its claim, with a reentrant withdrawAll during the claim.
        hooked.mint(address(account), 5e6);
        hooked.setBlocked(address(wallet), true);
        wallet.exec(address(account), abi.encodeCall(CustodyCoreV3.withdrawAll, (address(wallet))));
        assertEq(account.claimable(address(hooked), address(wallet)), 5e6);
        hooked.setBlocked(address(wallet), false);
        hooked.arm(wallet, address(account), p[1]);
        wallet.exec(address(account), abi.encodeCall(CustodyCoreV3.claim, (address(hooked), address(wallet))));
        assertRefused(1);
        assertEq(hooked.balanceOf(address(wallet)), 55e6);
        assertEq(account.claimable(address(hooked), address(wallet)), 0);
    }

    function test_NothingReentersADeposit() public {
        bytes[] memory p = payloads();
        hooked.mint(address(wallet), 10e6);
        hooked.arm(wallet, address(account), p[0]);
        wallet.exec(address(account), abi.encodeCall(PersonalAccountV3.deposit, (address(hooked), 10e6)));
        assertRefused(0);
        assertEq(hooked.balanceOf(address(account)), 60e6);
        assertEq(account.principal(), 60e6);
    }

    /// The opt-in has no external call and no guard, so a hook can flip it;
    /// that moves nothing, and the owner's own setting is what the registry reads next.
    function test_AHookCannotMoveFundsThroughTheOptIn() public {
        hooked.arm(wallet, address(account), abi.encodeCall(PersonalAccountV3.setScreenedOptIn, (true)));
        wallet.exec(address(account), abi.encodeCall(CustodyCoreV3.withdraw, (address(hooked), 1e6, address(wallet))));
        assertTrue(hooked.lastCallSucceeded());
        assertTrue(account.screenedOptIn());
        assertEq(hooked.balanceOf(address(account)), 49e6);
    }
}
