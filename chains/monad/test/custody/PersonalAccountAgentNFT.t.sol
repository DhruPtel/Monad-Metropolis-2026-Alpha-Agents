// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {AccountFactory} from "../../src/custody/AccountFactory.sol";
import {PersonalAccount} from "../../src/custody/PersonalAccount.sol";
import {IAgentNFTView, SwapParams} from "../../src/interfaces/ICustody.sol";
import {AgentNFTBase} from "../AgentNFTBase.sol";
import {MockExecutor, MockOracle, MockToken} from "../mocks/CustodyMocks.sol";

/// The custody contracts against the real AgentNFT: its `ownerOf` and
/// `ownerEpoch` are what they read, and a sale through the escrow stops the
/// seller's trading in the same transaction while their withdrawal stays.
contract PersonalAccountAgentNFTTest is AgentNFTBase {
    MockToken internal usdc;
    MockToken internal wmon;
    MockOracle internal oracle;
    MockExecutor internal executor;
    AccountFactory internal factory;

    function setUp() public override {
        super.setUp();
        usdc = new MockToken("USDC", 6);
        wmon = new MockToken("WMON", 18);
        oracle = new MockOracle();
        oracle.set(address(usdc), 6, 1e6);
        oracle.set(address(wmon), 18, 500_000);
        executor = new MockExecutor(oracle);
        address[] memory allow = new address[](0);
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
        vm.startPrank(admin);
        factory.propose(AccountFactory.Action.DisableAllowlist, bytes32(0));
        factory.propose(AccountFactory.Action.SetOracle, bytes32(uint256(uint160(address(oracle)))));
        factory.propose(AccountFactory.Action.SetExecutor, bytes32(uint256(uint160(address(executor)))));
        vm.stopPrank();
        vm.warp(block.timestamp + 9 days);
        factory.execute(AccountFactory.Action.DisableAllowlist, bytes32(0));
        factory.execute(AccountFactory.Action.SetOracle, bytes32(uint256(uint160(address(oracle)))));
        factory.execute(AccountFactory.Action.SetExecutor, bytes32(uint256(uint160(address(executor)))));
    }

    function test_ASaleThroughTheEscrowStopsTrading_AndTheSellerStillWithdraws() public {
        address seller = freshWallet();
        uint256 id = mintWithValidClaim(seller);
        vm.prank(seller);
        PersonalAccount account = PersonalAccount(factory.createPersonalAccount(id));
        usdc.mint(seller, 50e6);
        vm.startPrank(seller);
        usdc.approve(address(account), 50e6);
        account.deposit(address(usdc), 50e6);
        vm.stopPrank();

        SwapParams memory p = SwapParams({
            tokenIn: address(usdc),
            tokenOut: address(wmon),
            amountIn: 1e6,
            minAmountOut: 1,
            poolId: bytes32(0),
            deadline: uint64(block.timestamp + 120),
            ownershipEpoch: nft.ownerEpoch(id),
            configEpoch: 0
        });
        executor.swap(account, p);

        setEscrow();
        address buyer = freshWallet();
        escrowMove(id, buyer);
        assertEq(nft.ownerEpoch(id), 1);
        vm.expectRevert(abi.encodeWithSelector(PersonalAccount.NotAgentOwner.selector, buyer));
        executor.swap(account, p);

        vm.prank(seller);
        account.withdrawAll(seller);
        assertEq(usdc.balanceOf(seller), 49e6);
        assertEq(wmon.balanceOf(seller), 2e18);

        // The buyer opens their own account for the same agent.
        vm.prank(buyer);
        address theirs = factory.createPersonalAccount(id);
        assertTrue(theirs != address(account));
    }

    function test_OnlyTheCurrentOwnerOfAMintedAgentCreatesItsAccount() public {
        address minter = freshWallet();
        uint256 id = mintWithValidClaim(minter);
        address other = freshWallet();
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(AccountFactory.NotAgentOwner.selector, other, minter));
        factory.createPersonalAccount(id);
        vm.prank(other);
        vm.expectRevert();
        factory.createPersonalAccount(999);
    }
}
