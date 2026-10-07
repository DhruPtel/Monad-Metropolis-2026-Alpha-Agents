// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {UniswapV3UsdcWmonAdapter} from "../../src/venues/UniswapV3UsdcWmonAdapter.sol";
import {UniswapV4MonUsdcAdapter} from "../../src/venues/UniswapV4MonUsdcAdapter.sol";
import {IPoolManager, ISwapRouter02} from "../../src/interfaces/IUniswap.sol";
import {IFiatToken, IWMON} from "./CustodyFork.t.sol";

/// The venue adapters against the real Uniswap v4 MON/USDC 0.05% pool and the
/// real v3 USDC/WMON 0.3% pool at the pinned block (P2-U2), with this test as
/// the Executor. The full Executor path on the fork is in ExecutorFork.t.sol.
/// Runs only on a fork named by LOCAL_FORK_URL (L-100).
contract VenueForkTest is Test {
    IFiatToken internal constant USDC = IFiatToken(0x754704Bc059F8C67012fEd69BC8A327a5aafb603);
    IWMON internal constant WMON = IWMON(0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A);
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e);
    ISwapRouter02 internal constant ROUTER = ISwapRouter02(0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900);
    bytes32 internal constant POOL_ID = 0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954;
    /// MON/USD at the pinned block: $0.0343682.
    uint256 internal constant MON_PRICE_E18 = 34_368_200_000_000_000;

    UniswapV4MonUsdcAdapter internal v4;
    UniswapV3UsdcWmonAdapter internal v3;
    address internal account = makeAddr("account");

    function setUp() public {
        string memory url = vm.envOr("LOCAL_FORK_URL", string(""));
        if (bytes(vm.envOr("MONAD_RPC_URL", string(""))).length == 0 || bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        vm.rollFork(vm.parseJsonUint(vm.readFile("./fork.json"), ".blockNumber"));
        v4 = new UniswapV4MonUsdcAdapter(POOL_MANAGER, address(USDC), address(WMON), address(this), POOL_ID);
        v3 = new UniswapV3UsdcWmonAdapter(ROUTER, address(USDC), address(WMON), address(this));
    }

    function fundUsdc(address to, uint256 amount) internal {
        vm.prank(USDC.masterMinter());
        USDC.configureMinter(address(this), amount);
        USDC.mint(to, amount);
    }

    function fundWmon(address to, uint256 amount) internal {
        vm.deal(address(this), amount);
        WMON.deposit{value: amount}();
        require(IFiatToken(address(WMON)).transfer(to, amount));
    }

    /// The value of a WMON amount in USDC base units at the pinned oracle price.
    function oracleValue(uint256 wmon) internal pure returns (uint256) {
        return wmon * MON_PRICE_E18 / 1e30;
    }

    function test_V4SellsWmonForUsdcPaidStraightToTheAccount() public {
        uint256 amountIn = 300 ether; // about $10.31
        fundWmon(address(v4), amountIn);
        uint256 out = v4.swap(address(WMON), address(USDC), amountIn, 1, account);
        assertEq(USDC.balanceOf(account), out);
        assertGt(out, oracleValue(amountIn) * 9_950 / 10_000, "within 0.5% of the oracle");
        assertEq(IFiatToken(address(WMON)).balanceOf(address(v4)), 0);
        assertEq(USDC.balanceOf(address(v4)), 0);
        assertEq(address(v4).balance, 0, "no native MON left");
        assertEq(IFiatToken(address(WMON)).allowance(address(v4), address(POOL_MANAGER)), 0);
    }

    function test_V4BuysWmonWithUsdcAndRewrapsIt() public {
        uint256 amountIn = 10e6;
        fundUsdc(address(v4), amountIn);
        uint256 out = v4.swap(address(USDC), address(WMON), amountIn, 1, account);
        assertEq(IFiatToken(address(WMON)).balanceOf(account), out, "the account got WMON, not native MON");
        assertEq(account.balance, 0);
        assertGt(oracleValue(out), amountIn * 9_950 / 10_000, "within 0.5% of the oracle");
        assertEq(USDC.balanceOf(address(v4)), 0);
        assertEq(address(v4).balance, 0);
        assertEq(USDC.allowance(address(v4), address(POOL_MANAGER)), 0);
    }

    function test_V4RefusesAnOutputBelowTheMinimum() public {
        fundUsdc(address(v4), 10e6);
        vm.expectRevert();
        v4.swap(address(USDC), address(WMON), 10e6, 10_000 ether, account);
    }

    function test_V4RefusesEveryCallerButTheExecutorAndStrayMon() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(abi.encodeWithSelector(UniswapV4MonUsdcAdapter.NotExecutor.selector, makeAddr("stranger")));
        v4.swap(address(USDC), address(WMON), 1, 1, account);
        vm.expectRevert(abi.encodeWithSelector(UniswapV4MonUsdcAdapter.NotPoolManager.selector, address(this)));
        v4.unlockCallback("");
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(v4).call{value: 1 ether}("");
        assertFalse(ok, "native MON from a stranger is refused");
    }

    function test_V3FallbackSwapsBothWaysWithAnExactApprovalResetToZero() public {
        fundUsdc(address(v3), 10e6);
        uint256 out = v3.swap(address(USDC), address(WMON), 10e6, 1, account);
        assertEq(IFiatToken(address(WMON)).balanceOf(account), out);
        assertEq(USDC.allowance(address(v3), address(ROUTER)), 0);
        fundWmon(address(v3), 300 ether);
        uint256 back = v3.swap(address(WMON), address(USDC), 300 ether, 1, account);
        assertEq(USDC.balanceOf(account), back);
        assertEq(IFiatToken(address(WMON)).allowance(address(v3), address(ROUTER)), 0);
    }
}
