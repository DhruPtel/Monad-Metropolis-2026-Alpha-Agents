// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {AccountFactory} from "../../src/custody/AccountFactory.sol";
import {PersonalAccount} from "../../src/custody/PersonalAccount.sol";
import {AccountMode, IAgentNFTView, SwapParams} from "../../src/interfaces/ICustody.sol";
import {MockAgentNFT, MockExecutor, MockOracle, MockToken} from "../mocks/CustodyMocks.sol";

/// Shared setup for the custody tests: the factory and one PersonalAccount
/// over mock tokens, AgentNFT, oracle and Executor. Caps are the beta's:
/// 100 USDC per account and 2,000 USDC across the platform (D-133). The
/// oracle is set through the timelock in setUp, since every deposit needs it
/// for the depeg guard (P2-U3); the Executor starts unset.
abstract contract CustodyBase is Test {
    uint256 internal constant PERSONAL_CAP = 100e6;
    uint256 internal constant PLATFORM_CAP = 2_000e6;
    uint256 internal constant AGENT = 7;
    /// MON at 0.50 USDC.
    uint256 internal constant MON_PRICE_E6 = 500_000;

    MockToken internal usdc;
    MockToken internal wmon;
    MockAgentNFT internal nft;
    MockOracle internal oracle;
    MockExecutor internal executor;
    AccountFactory internal factory;
    PersonalAccount internal account;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal sentinel = makeAddr("sentinel");
    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        usdc = new MockToken("USDC", 6);
        wmon = new MockToken("WMON", 18);
        nft = new MockAgentNFT();
        oracle = new MockOracle();
        oracle.set(address(usdc), 6, 1e6);
        oracle.set(address(wmon), 18, MON_PRICE_E6);
        executor = new MockExecutor(oracle);
        address[] memory allow = new address[](1);
        allow[0] = owner;
        factory = new AccountFactory(
            admin,
            guardian,
            sentinel,
            IAgentNFTView(address(nft)),
            address(usdc),
            address(wmon),
            PERSONAL_CAP,
            PLATFORM_CAP,
            allow
        );
        nft.setOwner(AGENT, owner);
        vm.prank(owner);
        account = PersonalAccount(factory.createPersonalAccount(AGENT));
        setOracle();
    }

    // ----- helpers -----

    function deposit(MockToken token, uint256 amount) internal {
        token.mint(owner, amount);
        vm.startPrank(owner);
        token.approve(address(account), amount);
        account.deposit(address(token), amount);
        vm.stopPrank();
    }

    /// Passes a timelocked change: propose, wait, execute.
    function timelocked(AccountFactory.Action action, bytes32 value) internal {
        vm.prank(admin);
        factory.propose(action, value);
        vm.warp(block.timestamp + factory.RISK_TIMELOCK());
        factory.execute(action, value);
    }

    function setOracle() internal {
        if (factory.oracle() == address(oracle)) return;
        timelocked(AccountFactory.Action.SetOracle, bytes32(uint256(uint160(address(oracle)))));
    }

    function setExecutor() internal {
        timelocked(AccountFactory.Action.SetExecutor, bytes32(uint256(uint160(address(executor)))));
    }

    /// A funded account with the oracle and Executor live: 60 USDC and 40 USDC of WMON.
    function tradingAccount() internal {
        setOracle();
        setExecutor();
        deposit(usdc, 60e6);
        deposit(wmon, 80e18);
    }

    function params(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (SwapParams memory) {
        return SwapParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: 1,
            poolId: bytes32(0),
            deadline: uint64(block.timestamp + 120),
            ownershipEpoch: nft.ownerEpoch(AGENT),
            configEpoch: 0
        });
    }

    function usdcBal(address who) internal view returns (uint256) {
        return usdc.balanceOf(who);
    }

    function wmonBal(address who) internal view returns (uint256) {
        return wmon.balanceOf(who);
    }

    function assertMode(AccountMode expected) internal view {
        assertEq(uint8(account.mode()), uint8(expected));
    }
}
