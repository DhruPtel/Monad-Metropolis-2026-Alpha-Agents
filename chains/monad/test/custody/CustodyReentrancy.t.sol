// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccountFactory} from "../../src/custody/AccountFactory.sol";
import {CustodyCore} from "../../src/custody/CustodyCore.sol";
import {PersonalAccount} from "../../src/custody/PersonalAccount.sol";
import {IAgentNFTView, SwapParams} from "../../src/interfaces/ICustody.sol";
import {MockAgentNFT, MockOracle, MockToken, OwnerWallet, ReentrantToken} from "../mocks/CustodyMocks.sol";

/// Reentrancy (P2-U1): the owner itself calls back into the account while a
/// withdrawal, credit claim or deposit is moving tokens. Every entry point is
/// refused by the guard, and the balances come out exactly right.
contract CustodyReentrancyTest is Test {
    ReentrantToken internal usdc;
    MockToken internal wmon;
    MockAgentNFT internal nft;
    AccountFactory internal factory;
    PersonalAccount internal account;
    OwnerWallet internal wallet;
    address internal admin = makeAddr("admin");

    function setUp() public {
        usdc = new ReentrantToken();
        wmon = new MockToken("WMON", 18);
        nft = new MockAgentNFT();
        wallet = new OwnerWallet();
        address[] memory allow = new address[](1);
        allow[0] = address(wallet);
        factory = new AccountFactory(
            admin,
            makeAddr("guardian"),
            makeAddr("sentinel"),
            IAgentNFTView(address(nft)),
            address(usdc),
            address(wmon),
            100e6,
            2_000e6,
            allow
        );
        nft.setOwner(1, address(wallet));
        // Deposits need the oracle (the depeg guard, P2-U3): set it through the timelock.
        MockOracle oracle = new MockOracle();
        oracle.set(address(usdc), 6, 1e6);
        oracle.set(address(wmon), 18, 500_000);
        bytes32 value = bytes32(uint256(uint160(address(oracle))));
        vm.prank(admin);
        factory.propose(AccountFactory.Action.SetOracle, value);
        vm.warp(block.timestamp + 9 days);
        factory.execute(AccountFactory.Action.SetOracle, value);
        account = PersonalAccount(
            abi.decode(
                wallet.exec(address(factory), abi.encodeCall(AccountFactory.createPersonalAccount, (1))), (address)
            )
        );
        usdc.mint(address(wallet), 50e6);
        wallet.exec(address(usdc), abi.encodeCall(usdc.approve, (address(account), type(uint256).max)));
        wallet.exec(address(account), abi.encodeCall(PersonalAccount.deposit, (address(usdc), 50e6)));
    }

    /// Every state-changing entry point, as the owner would call it.
    function payloads() internal view returns (bytes[] memory p) {
        SwapParams memory s;
        p = new bytes[](8);
        p[0] = abi.encodeCall(CustodyCore.withdraw, (address(usdc), 1e6, address(wallet)));
        p[1] = abi.encodeCall(CustodyCore.withdrawAll, (address(wallet)));
        p[2] = abi.encodeCall(CustodyCore.claim, (address(usdc), address(wallet)));
        p[3] = abi.encodeCall(PersonalAccount.deposit, (address(usdc), 1e6));
        p[4] = abi.encodeCall(CustodyCore.executeSwap, (s));
        p[5] = abi.encodeCall(CustodyCore.poke, ());
        p[6] = abi.encodeCall(CustodyCore.pullForSwap, (address(usdc), 1e6));
        p[7] = abi.encodeCall(PersonalAccount.initialize, (1, address(this)));
        return p;
    }

    function assertRefused(uint256 i) internal view {
        assertFalse(usdc.lastCallSucceeded(), "a reentrant call succeeded");
        bytes memory reason = usdc.lastRevert();
        bytes4 selector = bytes4(reason);
        if (i <= 5) assertEq(selector, ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        else if (i == 6) assertEq(selector, CustodyCore.SwapContextInvalid.selector);
        else assertEq(selector, PersonalAccount.AlreadyInitialized.selector);
    }

    function test_NothingReentersAWithdrawal() public {
        bytes[] memory p = payloads();
        for (uint256 i = 0; i < p.length; i++) {
            usdc.arm(wallet, address(account), p[i]);
            wallet.exec(address(account), abi.encodeCall(CustodyCore.withdraw, (address(usdc), 1e6, address(wallet))));
            assertRefused(i);
        }
        assertEq(usdc.balanceOf(address(account)), 50e6 - 8e6);
        assertEq(usdc.balanceOf(address(wallet)), 8e6);
    }

    function test_NothingReentersAWithdrawAllOrAClaim() public {
        bytes[] memory p = payloads();
        usdc.arm(wallet, address(account), p[0]);
        wallet.exec(address(account), abi.encodeCall(CustodyCore.withdrawAll, (address(wallet))));
        assertRefused(0);
        assertEq(usdc.balanceOf(address(wallet)), 50e6);

        // A credit, then its claim, with a reentrant withdrawAll during the claim.
        usdc.mint(address(account), 5e6);
        usdc.setBlocked(address(wallet), true);
        wallet.exec(address(account), abi.encodeCall(CustodyCore.withdrawAll, (address(wallet))));
        assertEq(account.claimable(address(usdc)), 5e6);
        usdc.setBlocked(address(wallet), false);
        usdc.arm(wallet, address(account), p[1]);
        wallet.exec(address(account), abi.encodeCall(CustodyCore.claim, (address(usdc), address(wallet))));
        assertRefused(1);
        assertEq(usdc.balanceOf(address(wallet)), 55e6);
        assertEq(account.claimable(address(usdc)), 0);
    }

    function test_NothingReentersADeposit() public {
        bytes[] memory p = payloads();
        usdc.mint(address(wallet), 10e6);
        usdc.arm(wallet, address(account), p[0]);
        wallet.exec(address(account), abi.encodeCall(PersonalAccount.deposit, (address(usdc), 10e6)));
        assertRefused(0);
        assertEq(usdc.balanceOf(address(account)), 60e6);
        assertEq(account.principal(), 60e6);
    }
}
