// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {StrategyVaultV3} from "../../src/fund/StrategyVaultV3.sol";
import {SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
import {MockToken, OwnerWallet, ReentrantToken} from "../mocks/CustodyMocks.sol";
import {StrategyVaultV3Base} from "./StrategyVaultV3Base.sol";

/// Reentrancy (P7-U1): the leader, a contract, calls back into the vault
/// while a deposit, a USDC exit, an in-kind exit or a claim is moving USDC,
/// USDC being a token with receiver hooks. Every guarded entry point is
/// refused, and the amounts come out exactly right.
contract StrategyVaultV3ReentrancyTest is StrategyVaultV3Base {
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
        wallet.exec(address(hooked), abi.encodeCall(hooked.approve, (address(sv), type(uint256).max)));
        wallet.exec(address(sv), abi.encodeCall(StrategyVaultV3.deposit, (SEED, 0)));
        wallet.exec(address(sv), abi.encodeCall(StrategyVaultV3.setDepositsOpen, (true)));
        depositAs(alice, 100e6);
    }

    /// Every guarded state-changing entry point, as the leader would call it.
    function payloads() internal view returns (bytes[] memory p) {
        SwapParamsV3 memory s;
        p = new bytes[](10);
        p[0] = abi.encodeCall(StrategyVaultV3.deposit, (1e6, 0));
        p[1] = abi.encodeCall(StrategyVaultV3.redeem, (1, address(wallet), 0, uint64(block.timestamp + 60)));
        p[2] = abi.encodeCall(StrategyVaultV3.redeemInKind, (1, address(wallet)));
        p[3] = abi.encodeCall(CustodyCoreV3.claim, (address(hooked), address(wallet)));
        p[4] = abi.encodeCall(StrategyVaultV3.stakeAsIncomingLeader, (1e6, 0));
        p[5] = abi.encodeCall(StrategyVaultV3.acceptManagement, ());
        p[6] = abi.encodeCall(StrategyVaultV3.pokeReference, ());
        p[7] = abi.encodeWithSignature("poke()");
        p[8] = abi.encodeCall(CustodyCoreV3.executeSwap, (s));
        p[9] = abi.encodeCall(CustodyCoreV3.pullForSwap, (address(hooked), 1));
        return p;
    }

    function assertRefused(uint256 i) internal view {
        assertFalse(hooked.lastCallSucceeded(), "a reentrant call succeeded");
        bytes4 selector = bytes4(hooked.lastRevert());
        if (i <= 8) assertEq(selector, ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        else assertEq(selector, CustodyCoreV3.SwapContextInvalid.selector);
    }

    function test_ReentryDuringADepositIsRefused() public {
        bytes[] memory p = payloads();
        for (uint256 i = 0; i < p.length; ++i) {
            uint256 before = sv.sharesOf(address(wallet));
            hooked.arm(wallet, address(sv), p[i]);
            wallet.exec(address(sv), abi.encodeCall(StrategyVaultV3.deposit, (1e6, 0)));
            assertRefused(i);
            assertGt(sv.sharesOf(address(wallet)), before);
        }
    }

    function test_ReentryDuringAUsdcExitIsRefused() public {
        passLockup();
        bytes[] memory p = payloads();
        for (uint256 i = 0; i < p.length; ++i) {
            uint256 before = hooked.balanceOf(address(wallet));
            hooked.arm(wallet, address(sv), p[i]);
            bytes memory ret = wallet.exec(
                address(sv),
                abi.encodeCall(StrategyVaultV3.redeem, (1e18, address(wallet), 0, uint64(block.timestamp + 60)))
            );
            assertRefused(i);
            assertEq(hooked.balanceOf(address(wallet)) - before, abi.decode(ret, (uint256)));
        }
    }

    function test_ReentryDuringAnInKindExitIsRefused() public {
        passLockup();
        bytes[] memory p = payloads();
        for (uint256 i = 0; i < p.length; ++i) {
            uint256 before = hooked.balanceOf(address(wallet));
            uint256 supply = sv.totalSupply();
            uint256 held = hooked.balanceOf(address(sv));
            hooked.arm(wallet, address(sv), p[i]);
            wallet.exec(address(sv), abi.encodeCall(StrategyVaultV3.redeemInKind, (1e18, address(wallet))));
            assertRefused(i);
            assertEq(hooked.balanceOf(address(wallet)) - before, held * 1e18 / supply, "the slice came out whole");
            assertEq(sv.claimable(address(hooked), address(wallet)), 0, "no credit: the transfer succeeded");
        }
    }

    function test_ReentryDuringAClaimIsRefused() public {
        passLockup();
        // A credit first: the vault blacklisted in USDC during an in-kind exit.
        hooked.setBlocked(address(sv), true);
        wallet.exec(address(sv), abi.encodeCall(StrategyVaultV3.redeemInKind, (1e18, address(wallet))));
        uint256 credit = sv.claimable(address(hooked), address(wallet));
        assertGt(credit, 0);
        hooked.setBlocked(address(sv), false);
        hooked.arm(wallet, address(sv), payloads()[0]);
        uint256 before = hooked.balanceOf(address(wallet));
        wallet.exec(address(sv), abi.encodeCall(CustodyCoreV3.claim, (address(hooked), address(wallet))));
        assertRefused(0);
        assertEq(hooked.balanceOf(address(wallet)) - before, credit);
    }
}
