// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

// Minimal interfaces to Uniswap v3 and v4, written from their published ABIs
// (clean-room: no third-party source is copied).

/// A v4 pool's key: currency0 < currency1, native MON is address zero.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// v4's swap parameters: a negative amountSpecified is an exact input.
struct V4SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

/// The parts of Uniswap v4's PoolManager the adapter uses.
interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);

    /// Returns a BalanceDelta: amount0 in the upper 128 bits, amount1 in the
    /// lower, each negative when the caller owes the pool.
    function swap(PoolKey memory key, V4SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 delta);

    function sync(address currency) external;

    function settle() external payable returns (uint256 paid);

    function take(address currency, address to, uint256 amount) external;
}

/// What PoolManager calls back on the unlocker.
interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// Uniswap v3's SwapRouter02 (no deadline in its single-hop params).
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// Wrapped MON.
interface IWMON {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}
