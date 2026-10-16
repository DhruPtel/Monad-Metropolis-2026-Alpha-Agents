// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// A Uniswap v2 family pair as a fork like nad.fun runs it: paid by transfer
/// first, then swapped; the constant product is checked after its own fee in
/// millionths, as a real v2 pair checks its fixed 0.3%.
contract MockV2Pair {
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable feePpm;
    uint112 internal reserve0;
    uint112 internal reserve1;

    constructor(address t0, address t1, uint24 fee) {
        factory = msg.sender;
        token0 = t0;
        token1 = t1;
        feePpm = fee;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }

    function sync() public {
        reserve0 = uint112(IERC20(token0).balanceOf(address(this)));
        reserve1 = uint112(IERC20(token1).balanceOf(address(this)));
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out > 0 || amount1Out > 0, "no output");
        (uint256 r0, uint256 r1) = (reserve0, reserve1);
        require(amount0Out < r0 && amount1Out < r1, "no liquidity");
        if (amount0Out > 0) IERC20(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20(token1).transfer(to, amount1Out);
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - amount0Out ? b0 - (r0 - amount0Out) : 0;
        uint256 in1 = b1 > r1 - amount1Out ? b1 - (r1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "no input");
        uint256 adj0 = b0 * 1_000_000 - in0 * feePpm;
        uint256 adj1 = b1 * 1_000_000 - in1 * feePpm;
        require(adj0 * adj1 >= r0 * r1 * 1e12, "K");
        reserve0 = uint112(b0);
        reserve1 = uint112(b1);
    }
}

/// A Uniswap v2 family factory: one pair per token pair, either order.
contract MockV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address a, address b, uint24 feePpm) external returns (address pair) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        pair = address(new MockV2Pair(t0, t1, feePpm));
        getPair[t0][t1] = pair;
        getPair[t1][t0] = pair;
    }
}

/// A token that keeps 1% of every transfer: a v2 hop must refuse it by name.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) return super._update(from, to, value);
        uint256 cut = value / 100;
        super._update(from, address(0xdead), cut);
        super._update(from, to, value - cut);
    }
}
