// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

// Minimal interfaces to external contracts AgentNFT calls, written from their
// published ABIs (clean-room: no third-party source is copied).

/// The canonical ERC-6551 registry at 0x000000006551c19487814612e58FE06813775758.
interface IERC6551Registry {
    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address account);

    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external
        view
        returns (address account);
}

/// The parts of a Tokenbound v3 account (AccountProxy in front of
/// AccountV3Upgradable) that AgentNFT uses.
interface ITokenboundAccount {
    /// AccountProxy: sets the implementation once; no caller check.
    function initialize(address implementation) external;

    /// AccountV3Upgradable: reads any storage slot of the account.
    function extsload(bytes32 slot) external view returns (bytes32);

    /// ERC-6551: the token this account is bound to.
    function token() external view returns (uint256 chainId, address tokenContract, uint256 tokenId);
}

/// The parts of Pyth Entropy v2 that AgentNFT uses.
interface IEntropyV2 {
    /// Requests a random number from the default provider with its default
    /// callback gas limit. Entropy later calls `_entropyCallback` on the sender.
    function requestV2() external payable returns (uint64 sequenceNumber);

    /// The fee for `requestV2()`.
    function getFeeV2() external view returns (uint128 fee);
}
