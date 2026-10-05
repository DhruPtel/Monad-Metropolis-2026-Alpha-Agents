// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// Unit-test stand-ins for the canonical ERC-6551 registry, a Tokenbound
/// account, Pyth Entropy and the marketplace escrow. The fork tests use the
/// real registry, account and Entropy instead.

contract MockAccount {
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    error AlreadyInitialized();
    error InvalidImplementation();

    uint256 internal immutable CHAIN_ID;
    address internal immutable TOKEN_CONTRACT;
    uint256 internal immutable TOKEN_ID;
    address internal immutable ALLOWED_IMPLEMENTATION;

    constructor(uint256 chainId, address tokenContract, uint256 tokenId, address allowedImplementation) {
        CHAIN_ID = chainId;
        TOKEN_CONTRACT = tokenContract;
        TOKEN_ID = tokenId;
        ALLOWED_IMPLEMENTATION = allowedImplementation;
    }

    /// Like AccountProxy: once, and only to the allowed implementation.
    function initialize(address implementation) external {
        if (implementation != ALLOWED_IMPLEMENTATION) revert InvalidImplementation();
        bytes32 slot = IMPLEMENTATION_SLOT;
        address current;
        assembly {
            current := sload(slot)
        }
        if (current != address(0)) revert AlreadyInitialized();
        assembly {
            sstore(slot, implementation)
        }
    }

    function extsload(bytes32 slot) external view returns (bytes32 value) {
        assembly {
            value := sload(slot)
        }
    }

    function token() external view returns (uint256, address, uint256) {
        return (CHAIN_ID, TOKEN_CONTRACT, TOKEN_ID);
    }
}

/// Deterministic, permissionless and idempotent, like the canonical registry.
contract MockRegistry {
    address public immutable ALLOWED_IMPLEMENTATION;

    constructor(address allowedImplementation) {
        ALLOWED_IMPLEMENTATION = allowedImplementation;
    }

    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address) {
        address predicted = account(implementation, salt, chainId, tokenContract, tokenId);
        if (predicted.code.length > 0) return predicted;
        return address(
            new MockAccount{salt: _salt(implementation, salt, chainId, tokenContract, tokenId)}(
                chainId, tokenContract, tokenId, ALLOWED_IMPLEMENTATION
            )
        );
    }

    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        public
        view
        returns (address)
    {
        bytes memory initCode = abi.encodePacked(
            type(MockAccount).creationCode, abi.encode(chainId, tokenContract, tokenId, ALLOWED_IMPLEMENTATION)
        );
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                _salt(implementation, salt, chainId, tokenContract, tokenId),
                keccak256(initCode)
            )
        );
        return address(uint160(uint256(hash)));
    }

    function _salt(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(implementation, salt, chainId, tokenContract, tokenId));
    }
}

interface IEntropyConsumerCallback {
    function _entropyCallback(uint64 sequence, address provider, bytes32 randomNumber) external;
}

/// Records requests and lets a test deliver any number for any request.
contract MockEntropy {
    uint128 public fee = 1.4 ether;
    uint64 public lastSequence = 1000;
    address public constant PROVIDER = address(0xF0E7);
    mapping(uint64 sequence => address requester) public requesterOf;

    error FeeTooLow();

    function setFee(uint128 newFee) external {
        fee = newFee;
    }

    function getFeeV2() external view returns (uint128) {
        return fee;
    }

    function requestV2() external payable returns (uint64 sequence) {
        if (msg.value < fee) revert FeeTooLow();
        sequence = ++lastSequence;
        requesterOf[sequence] = msg.sender;
    }

    function fulfill(uint64 sequence, bytes32 randomNumber) external {
        IEntropyConsumerCallback(requesterOf[sequence])._entropyCallback(sequence, PROVIDER, randomNumber);
    }
}

/// The only address allowed to move agents once set.
contract MockEscrow {
    function move(IERC721 nft, address from, address to, uint256 agentId) external {
        nft.transferFrom(from, to, agentId);
    }

    function safeMove(IERC721 nft, address from, address to, uint256 agentId) external {
        nft.safeTransferFrom(from, to, agentId);
    }
}
