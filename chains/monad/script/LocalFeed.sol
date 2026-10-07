// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title LocalFeed
/// @notice Local fork only (P2-U2 step 0, D-237). A fork copies Chainlink's
/// feeds as they were at the pinned block and nothing updates them there, so
/// they go stale as the fork's clock moves. packages/devenv's
/// `refreshLocalFeeds` puts this code at each feed's address with
/// `anvil_setCode` and writes its storage with `anvil_setStorageAt`: both are
/// anvil-only methods, and devenv refuses any RPC that is not the local anvil
/// fork before sending anything. Nothing deploys this contract; it is never on
/// testnet or mainnet.
///
/// Storage, written directly by devenv (keep `LOCAL_FEED_SLOTS` in step):
///   slot 0: roundId (uint80, low bytes), then decimals (uint8), then down (bool)
///   slot 1: answer (int256)
///   slot 2: updatedAt (uint256)
contract LocalFeed {
    uint80 internal _roundId;
    uint8 internal _decimals;
    bool internal _down;
    int256 internal _answer;
    uint256 internal _updatedAt;

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!_down, "local feed down");
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }
}
