// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title TestnetFeed
/// @notice Monad testnet only (P2-EC, D-253). Chainlink has no MON/USD or
/// USDC/USD feed on testnet, and every deposit reads USDC/USD for the depeg
/// guard, so the testnet oracle adapter reads two of these instead. Each has
/// Chainlink's aggregator read interface, an answer set by one writer key (the
/// testnet feed key), and a `redate` that keeps the answer and moves its time,
/// which the testnet stack calls on demand before an action that needs a fresh
/// price (D-307). MON is priced at an operator value, not the market's (D-304).
/// The constructor refuses any chain but 10143, so this never reaches mainnet
/// or the fork; LocalFeed (D-237) is the fork's separate stand-in.
contract TestnetFeed {
    uint256 public constant MONAD_TESTNET_CHAIN_ID = 10143;

    uint8 public immutable decimals;
    address public immutable writer;
    string public description;

    uint80 internal _roundId;
    int256 internal _answer;
    uint256 internal _updatedAt;

    error WrongChain(uint256 chainId);
    error NotWriter(address caller);
    error BadAnswer(int256 answer);

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    constructor(uint8 decimals_, address writer_, string memory description_, int256 answer_) {
        if (block.chainid != MONAD_TESTNET_CHAIN_ID) revert WrongChain(block.chainid);
        if (answer_ <= 0) revert BadAnswer(answer_);
        decimals = decimals_;
        writer = writer_;
        description = description_;
        _write(answer_);
    }

    /// A new answer, dated now.
    function setAnswer(int256 answer_) external {
        if (msg.sender != writer) revert NotWriter(msg.sender);
        if (answer_ <= 0) revert BadAnswer(answer_);
        _write(answer_);
    }

    /// The same answer, dated now: a new round, as a Chainlink heartbeat would make.
    function redate() external {
        if (msg.sender != writer) revert NotWriter(msg.sender);
        _write(_answer);
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function latestAnswer() external view returns (int256) {
        return _answer;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function _write(int256 answer_) internal {
        _roundId += 1;
        _answer = answer_;
        _updatedAt = block.timestamp;
        emit AnswerUpdated(answer_, _roundId, block.timestamp);
    }
}
