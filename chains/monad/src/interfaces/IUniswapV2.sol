// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// The parts of a Uniswap v2 pair (or any v2 fork's) the fund agent reads and swaps through.
interface IUniswapV2Pair {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// The part of a Uniswap v2 factory (or any v2 fork's) the registry checks a pair against.
interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address);
}
