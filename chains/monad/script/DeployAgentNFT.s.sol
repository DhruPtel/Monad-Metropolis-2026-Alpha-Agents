// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console} from "forge-std/Script.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {IERC6551Registry, IEntropyV2} from "../src/interfaces/IExternal.sol";

/// Deploys AgentNFT through the deterministic CREATE2 factory, or finds the
/// existing deployment, then asserts the onchain state matches the intended
/// configuration (MV-S15 style). Run it through `pnpm deploy:agent-nft`,
/// which picks the target, refuses anything but the local fork or testnet,
/// and sets these variables:
///   AGENT_NFT_ADMIN, AGENT_NFT_CLAIM_SIGNER, AGENT_NFT_TREASURY,
///   AGENT_NFT_IMAGE_BASE_URI, AGENT_NFT_ENTROPY,
///   and DEPLOYER_PRIVATE_KEY on testnet only (the local fork uses an
///   unlocked anvil account).
contract DeployAgentNFT is Script {
    // CREATE2_FACTORY (0x4e59...956C) comes from forge-std; forge deploys
    // `new X{salt: ...}` through it when broadcasting.
    bytes32 public constant SALT = keccak256("alpha-agents.agent-nft.v1");

    // Canonical on Monad mainnet and testnet (packages/domain address book).
    address internal constant REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address internal constant ACCOUNT_PROXY = 0x55266d75D1a14E4572138116aF39863Ed6596E7F;
    address internal constant ACCOUNT_IMPLEMENTATION = 0x41C8f39463A868d3A88af00cd0fe7102F30E44eC;

    struct Config {
        address admin;
        address claimSigner;
        address treasury;
        string imageBaseURI;
        address entropy;
    }

    /// The local fork's own chain ID (D-195); it runs Monad mainnet's state and EVM.
    uint256 internal constant LOCAL_FORK_CHAIN_ID = 143143;
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10143;

    function run() external returns (AgentNFT nft) {
        // Mainnet (143) is added deliberately at the beta deployment (PB-U1).
        require(
            block.chainid == LOCAL_FORK_CHAIN_ID || block.chainid == MONAD_TESTNET_CHAIN_ID,
            "not the local fork (143143) or Monad testnet"
        );
        Config memory c = Config({
            admin: vm.envAddress("AGENT_NFT_ADMIN"),
            claimSigner: vm.envAddress("AGENT_NFT_CLAIM_SIGNER"),
            treasury: vm.envAddress("AGENT_NFT_TREASURY"),
            imageBaseURI: vm.envString("AGENT_NFT_IMAGE_BASE_URI"),
            entropy: vm.envAddress("AGENT_NFT_ENTROPY")
        });
        require(REGISTRY.code.length > 0 && ACCOUNT_PROXY.code.length > 0, "Tokenbound contracts missing");
        require(ACCOUNT_IMPLEMENTATION.code.length > 0, "Tokenbound implementation missing");
        require(c.entropy.code.length > 0, "Entropy missing");
        require(CREATE2_FACTORY.code.length > 0, "CREATE2 factory missing");

        bytes memory initCode = abi.encodePacked(
            type(AgentNFT).creationCode,
            abi.encode(
                c.admin,
                c.claimSigner,
                c.treasury,
                c.imageBaseURI,
                REGISTRY,
                ACCOUNT_PROXY,
                ACCOUNT_IMPLEMENTATION,
                c.entropy
            )
        );
        address predicted = vm.computeCreate2Address(SALT, keccak256(initCode), CREATE2_FACTORY);

        bool fresh = predicted.code.length == 0;
        if (!fresh) {
            console.log("AgentNFT already deployed");
            nft = AgentNFT(predicted);
        } else {
            uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
            if (key == 0) vm.startBroadcast();
            else vm.startBroadcast(key);
            nft = new AgentNFT{salt: SALT}(
                c.admin,
                c.claimSigner,
                c.treasury,
                c.imageBaseURI,
                IERC6551Registry(REGISTRY),
                ACCOUNT_PROXY,
                ACCOUNT_IMPLEMENTATION,
                IEntropyV2(c.entropy)
            );
            vm.stopBroadcast();
            require(address(nft) == predicted, "deployed address differs from prediction");
        }

        _assertImmutables(nft, c);
        if (fresh) _assertInitialState(nft, c);
        console.log("AGENT_NFT_ADDRESS", address(nft));
        console.log("AGENT_NFT_CODE_SIZE", address(nft).code.length);
    }

    /// What can never change after deployment.
    function _assertImmutables(AgentNFT nft, Config memory c) internal view {
        require(address(nft.ACCOUNT_REGISTRY()) == REGISTRY, "registry");
        require(nft.ACCOUNT_PROXY() == ACCOUNT_PROXY, "account proxy");
        require(nft.ACCOUNT_IMPLEMENTATION() == ACCOUNT_IMPLEMENTATION, "account implementation");
        require(address(nft.ENTROPY()) == c.entropy, "entropy");
        require(nft.MAX_SUPPLY() == 1000, "max supply");
    }

    /// A fresh deployment must be exactly what was intended. A later run
    /// against an existing deployment skips this, since the admin may have
    /// changed the settings since.
    function _assertInitialState(AgentNFT nft, Config memory c) internal view {
        require(nft.owner() == c.admin, "admin");
        require(nft.claimSigner() == c.claimSigner, "claim signer");
        require(nft.claimRequired(), "claim required at deploy");
        require(nft.treasury() == c.treasury, "treasury");
        (address receiver, uint256 royalty) = nft.royaltyInfo(1, 10_000);
        require(receiver == c.treasury && royalty == 500, "royalty");
        require(keccak256(bytes(nft.imageBaseURI())) == keccak256(bytes(c.imageBaseURI)), "image base");
        require(!nft.imageBaseURIFrozen(), "image link not frozen at deploy");
        require(nft.escrow() == address(0), "escrow unset at deploy");
        require(nft.totalMinted() == 0, "nothing minted at deploy");
    }
}
