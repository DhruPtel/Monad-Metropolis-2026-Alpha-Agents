// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IChainlinkFeed, IUniswapV4StateView} from "../../src/interfaces/IOracle.sol";

/// A Chainlink aggregator proxy whose every answer the test chooses,
/// including the ways a real feed can fail: a revert, a short answer, a
/// changed decimals, a non-positive answer, an incomplete round.
contract MockFeed is IChainlinkFeed {
    enum Failure {
        None,
        RevertRound,
        RevertDecimals,
        ShortRound,
        ShortDecimals
    }

    uint8 public dec;
    uint80 public roundId = 1;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public answeredInRound = 1;
    Failure public failure;

    constructor(uint8 decimals_) {
        dec = decimals_;
    }

    /// A fresh, complete round with this answer at this block's time.
    function push(int256 answer_) external {
        roundId++;
        answeredInRound = roundId;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function setRound(uint80 roundId_, int256 answer_, uint256 updatedAt_, uint80 answeredInRound_) external {
        roundId = roundId_;
        answer = answer_;
        updatedAt = updatedAt_;
        answeredInRound = answeredInRound_;
    }

    function setDecimals(uint8 d) external {
        dec = d;
    }

    function setFailure(Failure f) external {
        failure = f;
    }

    function decimals() external view returns (uint8) {
        if (failure == Failure.RevertDecimals) revert("decimals down");
        if (failure == Failure.ShortDecimals) {
            assembly {
                return(0, 16)
            }
        }
        return dec;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (failure == Failure.RevertRound) revert("feed down");
        if (failure == Failure.ShortRound) {
            assembly {
                mstore(0, 1)
                return(0, 64)
            }
        }
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

/// Uniswap v4's StateView for one pool, with a settable price.
contract MockStateView is IUniswapV4StateView {
    uint160 public sqrtPriceX96;
    bool public reverts;
    bytes32 public expectedPool;

    constructor(bytes32 poolId) {
        expectedPool = poolId;
    }

    function setSqrtPrice(uint160 p) external {
        sqrtPriceX96 = p;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function getSlot0(bytes32 poolId) external view returns (uint160, int24, uint24, uint24) {
        if (reverts) revert("pool down");
        require(poolId == expectedPool, "wrong pool");
        return (sqrtPriceX96, 0, 0, 500);
    }
}
