// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AccountFactory} from "../../src/custody/AccountFactory.sol";
import {CustodyCore} from "../../src/custody/CustodyCore.sol";
import {PersonalAccount} from "../../src/custody/PersonalAccount.sol";
import {IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {MockAgentNFT, MockOracle} from "../mocks/CustodyMocks.sol";

/// Circle's FiatToken, as far as these tests drive it.
interface IFiatToken is IERC20 {
    function masterMinter() external view returns (address);
    function blacklister() external view returns (address);
    function pauser() external view returns (address);
    function configureMinter(address minter, uint256 allowance) external returns (bool);
    function mint(address to, uint256 amount) external returns (bool);
    function blacklist(address account) external;
    function unBlacklist(address account) external;
    function pause() external;
    function unpause() external;
}

interface IWMON is IERC20 {
    function deposit() external payable;
}

/// PersonalAccount with Monad's real USDC (Circle's FiatToken, with its real
/// pause and blacklist) and WMON, on the local fork (P2-U1). The oracle and
/// AgentNFT are stand-ins: the oracle adapter is P2-U3, and AgentNFT has its
/// own fork test. Skipped without MONAD_RPC_URL.
contract CustodyForkTest is Test {
    string internal constant LOCAL_FORK_URL = "http://127.0.0.1:8545";
    IFiatToken internal constant USDC = IFiatToken(0x754704Bc059F8C67012fEd69BC8A327a5aafb603);
    IWMON internal constant WMON = IWMON(0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A);

    AccountFactory internal factory;
    PersonalAccount internal account;
    MockAgentNFT internal nft;
    address internal owner = makeAddr("fork owner");
    address internal admin = makeAddr("fork admin");

    function setUp() public {
        if (bytes(vm.envOr("MONAD_RPC_URL", string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("LOCAL_FORK_URL", LOCAL_FORK_URL));
        nft = new MockAgentNFT();
        nft.setOwner(1, owner);
        MockOracle oracle = new MockOracle();
        oracle.set(address(USDC), 6, 1e6);
        oracle.set(address(WMON), 18, 20_000);
        address[] memory allow = new address[](1);
        allow[0] = owner;
        factory = new AccountFactory(
            admin,
            makeAddr("guardian"),
            makeAddr("sentinel"),
            address(0),
            address(0),
            IAgentNFTView(address(nft)),
            address(USDC),
            address(WMON),
            100e6,
            2_000e6,
            allow
        );
        vm.prank(admin);
        factory.propose(AccountFactory.Action.SetOracle, bytes32(uint256(uint160(address(oracle)))));
        vm.warp(block.timestamp + 9 days);
        factory.execute(AccountFactory.Action.SetOracle, bytes32(uint256(uint160(address(oracle)))));
        vm.prank(owner);
        account = PersonalAccount(factory.createPersonalAccount(1));
    }

    function fundUsdc(address to, uint256 amount) internal {
        vm.prank(USDC.masterMinter());
        USDC.configureMinter(address(this), amount);
        USDC.mint(to, amount);
    }

    /// 50 USDC and 1,000 WMON (20 USDC at the stand-in price) from the owner.
    function depositBoth() internal {
        fundUsdc(owner, 50e6);
        vm.deal(owner, 1_000 ether);
        vm.startPrank(owner);
        WMON.deposit{value: 1_000 ether}();
        USDC.approve(address(account), 50e6);
        WMON.approve(address(account), 1_000 ether);
        account.deposit(address(USDC), 50e6);
        account.deposit(address(WMON), 1_000 ether);
        vm.stopPrank();
    }

    /// Both real tokens arrive exactly, so neither is fee-on-transfer, and both come back out.
    function test_RealUsdcAndWmonDepositExactlyAndWithdraw() public {
        depositBoth();
        assertEq(USDC.balanceOf(address(account)), 50e6);
        assertEq(WMON.balanceOf(address(account)), 1_000 ether);
        assertEq(account.principal(), 70e6);
        vm.prank(owner);
        account.withdraw(address(USDC), 20e6, owner);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(USDC.balanceOf(owner), 50e6);
        assertEq(WMON.balanceOf(owner), 1_000 ether);
        assertEq(account.principal(), 0);
        assertEq(factory.platformTotal(), 0);
    }

    /// Circle blacklists the account: USDC is credited, WMON still withdraws,
    /// and the credit pays out once the blacklist is lifted.
    function test_ABlacklistedAccountsUsdcIsCreditedAndWmonStillWithdraws() public {
        depositBoth();
        vm.prank(USDC.blacklister());
        USDC.blacklist(address(account));
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(WMON.balanceOf(owner), 1_000 ether);
        assertEq(account.claimable(address(USDC)), 50e6);
        vm.prank(owner);
        vm.expectRevert();
        account.claim(address(USDC), owner);
        vm.prank(USDC.blacklister());
        USDC.unBlacklist(address(account));
        vm.prank(owner);
        account.claim(address(USDC), owner);
        assertEq(USDC.balanceOf(owner), 50e6);
        assertEq(account.claimable(address(USDC)), 0);
    }

    /// Circle pauses USDC: the same, and a blacklisted owner claims to another address.
    function test_APausedUsdcIsCredited_AndABlacklistedOwnerClaimsElsewhere() public {
        depositBoth();
        vm.prank(USDC.pauser());
        USDC.pause();
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(WMON.balanceOf(owner), 1_000 ether);
        assertEq(account.claimable(address(USDC)), 50e6);
        vm.prank(USDC.pauser());
        USDC.unpause();
        vm.prank(USDC.blacklister());
        USDC.blacklist(owner);
        address safe = makeAddr("safe");
        vm.prank(owner);
        vm.expectRevert();
        account.claim(address(USDC), owner);
        vm.prank(owner);
        account.claim(address(USDC), safe);
        assertEq(USDC.balanceOf(safe), 50e6);
    }

    /// Native MON cannot be sent in: accounts hold WMON only (D-167).
    function test_RejectsNativeMon() public {
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        (bool ok,) = address(account).call{value: 1 ether}("");
        assertFalse(ok);
    }

    /// Withdrawal with every platform contract gone, on the real tokens.
    function test_WithdrawalNeedsOnlyTheTokens() public {
        depositBoth();
        vm.etch(address(factory), hex"fe");
        vm.etch(address(nft), hex"fe");
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(USDC.balanceOf(owner), 50e6);
        assertEq(WMON.balanceOf(owner), 1_000 ether);
        vm.expectRevert();
        CustodyCore(address(account)).navUsdc();
    }
}
