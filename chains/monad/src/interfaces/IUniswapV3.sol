// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

// Minimal interfaces to Uniswap v3 and PancakeSwap v3 pools and factories,
// written from their published ABIs (clean-room: no third-party source is
// copied). PancakeSwap v3 keeps Uniswap v3's pool interface; its swap callback
// is named `pancakeV3SwapCallback` and its `slot0` returns a wider fee field,
// so callers read only the first word (sqrtPriceX96).

interface IUniswapV3FactoryView {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IUniswapV3PoolView {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
}

interface IUniswapV3PoolActions {
    /// Swaps against the pool, paying the output to `recipient` and calling
    /// back the caller to collect the input. A positive amount is what the
    /// pool receives, a negative one what it pays.
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// What a v3 pool calls back on the swapper, under either venue's name.
interface IV3SwapCallbacks {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}
