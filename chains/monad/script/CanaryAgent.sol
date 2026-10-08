// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IAgentNFTView} from "../src/interfaces/ICustody.sol";

/// @title CanaryAgent
/// @notice A THROWAWAY CANARY for P2-EC part 2 on Monad mainnet (D-250). It
/// stands in for AgentNFT, which is not deployed on mainnet before PB-U1, for
/// the only two calls PersonalAccount, AccountFactory and the Executor make
/// into it (IAgentNFTView). It knows one agent, ID 1, owned by the address
/// fixed at construction, with ownership epoch 0, and reverts for any other
/// ID. It has no transfer, mint or approval function and is not an ERC-721,
/// so nothing lists it as a collection, and with no transfers the epoch never
/// moves. The constructor refuses any chain but Monad mainnet (143). Nothing
/// deployed with it carries into the beta (D-249).
contract CanaryAgent is IAgentNFTView {
    uint256 public constant MONAD_MAINNET_CHAIN_ID = 143;
    /// The one agent the canary knows.
    uint256 public constant AGENT_ID = 1;

    address public immutable owner;

    error WrongChain(uint256 chainId);
    error ZeroOwner();
    error UnknownAgent(uint256 agentId);

    constructor(address owner_) {
        if (block.chainid != MONAD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid);
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        if (agentId != AGENT_ID) revert UnknownAgent(agentId);
        return owner;
    }

    function ownerEpoch(uint256 agentId) external pure returns (uint64) {
        if (agentId != AGENT_ID) revert UnknownAgent(agentId);
        return 0;
    }
}
