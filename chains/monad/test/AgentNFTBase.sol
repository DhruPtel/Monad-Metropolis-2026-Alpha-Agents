// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {IERC6551Registry, IEntropyV2} from "../src/interfaces/IExternal.sol";
import {MockEntropy, MockEscrow, MockRegistry} from "./mocks/AgentNFTMocks.sol";

/// Shared setup for the AgentNFT unit, reveal and invariant tests: the
/// contract against mock registry, account and Entropy, with helpers.
abstract contract AgentNFTBase is Test {
    AgentNFT internal nft;
    MockRegistry internal registry;
    MockEntropy internal entropy;
    MockEscrow internal escrow;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    Vm.Wallet internal signer;
    address internal constant ACCOUNT_PROXY = address(0xA11CE);
    address internal constant ACCOUNT_IMPLEMENTATION = address(0x1A1A);
    string internal constant IMAGE_BASE = "ipfs://bafyimages/";

    uint8[25] internal SPECIES_COUNTS =
        [120, 120, 120, 120, 120, 38, 38, 38, 38, 37, 37, 37, 37, 1, 1, 1, 1, 12, 12, 12, 12, 12, 12, 12, 12];

    uint256 internal walletCounter;

    function setUp() public virtual {
        signer = vm.createWallet("claim signer");
        registry = new MockRegistry(ACCOUNT_IMPLEMENTATION);
        entropy = new MockEntropy();
        escrow = new MockEscrow();
        nft = new AgentNFT(
            admin,
            signer.addr,
            treasury,
            IMAGE_BASE,
            IERC6551Registry(address(registry)),
            ACCOUNT_PROXY,
            ACCOUNT_IMPLEMENTATION,
            IEntropyV2(address(entropy))
        );
    }

    // ----- wallets and claims -----

    /// A fresh wallet every call, so no test depends on another's state (L-15).
    function freshWallet() internal returns (address) {
        return makeAddr(string.concat("wallet-", vm.toString(++walletCounter)));
    }

    function claimDigest(address wallet, bytes32 nonce, uint64 deadline) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(nft.CLAIM_TYPEHASH(), wallet, nonce, deadline));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AlphaAgents AgentNFT"),
                keccak256("1"),
                block.chainid,
                address(nft)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function signClaim(uint256 key, address wallet, bytes32 nonce, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, claimDigest(wallet, nonce, deadline));
        return abi.encodePacked(r, s, v);
    }

    function mintWithValidClaim(address wallet) internal returns (uint256) {
        bytes32 nonce = keccak256(abi.encode("nonce", wallet));
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = signClaim(signer.privateKey, wallet, nonce, deadline);
        vm.prank(wallet);
        return nft.mintWithClaim(deadline, nonce, sig);
    }

    function openMint() internal {
        vm.prank(admin);
        nft.setClaimRequired(false);
    }

    /// Mints `n` agents to fresh wallets (claim mode must be off).
    function mintMany(uint256 n) internal {
        for (uint256 i = 0; i < n; ++i) {
            vm.prank(freshWallet());
            nft.mint();
        }
    }

    // ----- reveal -----

    function requestReveal() internal returns (uint64 sequence) {
        vm.deal(address(this), 10 ether);
        return nft.requestReveal{value: entropy.fee()}();
    }

    /// Requests, delivers `randomNumber` and applies the whole batch.
    function revealBatch(bytes32 randomNumber) internal {
        uint64 sequence = requestReveal();
        entropy.fulfill(sequence, randomNumber);
        nft.reveal(type(uint256).max);
    }

    function setEscrow() internal {
        vm.prank(admin);
        nft.setEscrow(address(escrow));
    }

    /// Escrow moves an agent; the holder approves the escrow first.
    function escrowMove(uint256 agentId, address to) internal {
        address from = nft.ownerOf(agentId);
        vm.prank(from);
        nft.approve(address(escrow), agentId);
        escrow.move(nft, from, to, agentId);
    }

    function speciesCounts() internal view returns (uint256[26] memory counts) {
        uint256 last = nft.nextToReveal() - 1;
        for (uint256 id = 1; id <= last; ++id) {
            ++counts[nft.speciesOf(id)];
        }
    }

    receive() external payable {}
}
