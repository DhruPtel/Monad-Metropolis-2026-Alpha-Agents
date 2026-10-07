// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVenueAdapter} from "../interfaces/IExecutor.sol";
import {ISwapRouter02} from "../interfaces/IUniswap.sol";

/// @title UniswapV3UsdcWmonAdapter
/// @notice The fallback venue (D-166): Uniswap v3's USDC/WMON 0.3% pool
/// through SwapRouter02, which takes a direct approval (no Permit2). It is
/// registered paused at launch; activating it waits the registry's timelock.
///
/// Only the Executor may call `swap`. The router is approved for exactly
/// `amountIn`, pays the account directly, and the approval is set back to
/// zero and checked before returning. Only the single-hop exact-input call is
/// used: none of the router's side doors (sweep, unwrap, refund, multicall).
contract UniswapV3UsdcWmonAdapter is IVenueAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant FEE = 3_000;

    ISwapRouter02 public immutable ROUTER;
    address public immutable USDC;
    address public immutable WMON;
    address public immutable EXECUTOR;

    error NotExecutor(address caller);
    error UnsupportedPair(address tokenIn, address tokenOut);
    error AllowanceLeft();

    constructor(ISwapRouter02 router, address usdc, address wmon, address executor) {
        ROUTER = router;
        USDC = usdc;
        WMON = wmon;
        EXECUTOR = executor;
    }

    function venue() external view returns (address) {
        return address(ROUTER);
    }

    /// 0.3%.
    function feeBps() external pure returns (uint256) {
        return 30;
    }

    function tradesPair(address tokenIn, address tokenOut) public view returns (bool) {
        return (tokenIn == WMON && tokenOut == USDC) || (tokenIn == USDC && tokenOut == WMON);
    }

    /// @inheritdoc IVenueAdapter
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.sender != EXECUTOR) revert NotExecutor(msg.sender);
        if (!tradesPair(tokenIn, tokenOut)) revert UnsupportedPair(tokenIn, tokenOut);
        IERC20(tokenIn).forceApprove(address(ROUTER), amountIn);
        amountOut = ROUTER.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: FEE,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).forceApprove(address(ROUTER), 0);
        if (IERC20(tokenIn).allowance(address(this), address(ROUTER)) != 0) revert AllowanceLeft();
    }
}
