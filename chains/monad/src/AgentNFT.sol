// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC6551Registry, ITokenboundAccount, IEntropyV2} from "./interfaces/IExternal.sol";

/// @title AgentNFT
/// @notice Every Alpha Agent is one token of this contract (FINAL_PLAN 4.1.1).
/// - Supply is a deck of exact counts: 25 species, 600 base, 300 medium and
///   100 pro, 1,000 in total (D-172, D-178, D-179). Nothing can change it.
/// - Two-step mint (D-180): mint creates an unrevealed agent; a reveal assigns
///   its species, and with it the tier, from Pyth Entropy (D-187).
/// - Each agent gets its Tokenbound v3 account in the mint transaction.
/// - The ownership epoch bumps on every transfer, and only the marketplace
///   escrow can transfer, once the admin has set it.
contract AgentNFT is ERC721, ERC2981, IERC4906, Ownable2Step, EIP712 {
    using Strings for uint256;

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    uint256 public constant MAX_SUPPLY = 1000;
    uint8 public constant SPECIES_COUNT = 25;

    /// Remaining count per species, 8 bits each, species 1 in the lowest byte.
    /// Must match packages/domain/src/species.ts (species.test.ts checks it).
    uint256 internal constant INITIAL_DECK = 0x0c0c0c0c0c0c0c0c0101010125252525262626267878787878;

    uint8 public constant TIER_BASE = 1;
    uint8 public constant TIER_MEDIUM = 2;
    uint8 public constant TIER_PRO = 3;

    /// 5% (D-185), in ERC-2981 basis points.
    uint96 public constant ROYALTY_BPS = 500;

    /// A request whose random number has not arrived after this long can be
    /// replaced. A delivered number is never replaced.
    uint64 public constant REVEAL_TIMEOUT = 1 hours;

    bytes32 public constant CLAIM_TYPEHASH = keccak256("MintClaim(address wallet,bytes32 nonce,uint64 deadline)");

    /// ERC-1967 implementation slot, read through the account's `extsload`.
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    uint256 internal constant MAX_IMAGE_BASE_URI_LENGTH = 256;

    // ---------------------------------------------------------------------
    // Immutable dependencies
    // ---------------------------------------------------------------------

    IERC6551Registry public immutable ACCOUNT_REGISTRY;
    /// Tokenbound AccountProxy: the implementation argument to the registry.
    address public immutable ACCOUNT_PROXY;
    /// Tokenbound AccountV3Upgradable: what every agent account must run.
    address public immutable ACCOUNT_IMPLEMENTATION;
    IEntropyV2 public immutable ENTROPY;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    struct Agent {
        /// 0 while unrevealed, then 1 to 25 in packages/domain SPECIES order.
        uint8 species;
        uint64 ownerEpoch;
        uint64 epochStartedAt;
    }

    /// The batch being revealed: agents `nextToReveal` to `batchLast`.
    struct RevealBatch {
        uint64 sequence;
        uint64 requestedAt;
        uint16 batchLast;
        bool seedReady;
    }

    mapping(uint256 agentId => Agent) internal _agents;
    mapping(address wallet => bool) public hasMinted;
    mapping(bytes32 nonce => bool) public claimNonceUsed;

    uint16 public totalMinted;
    /// The next agent to reveal; agents below it are revealed.
    uint16 public nextToReveal = 1;
    uint256 internal _deck = INITIAL_DECK;

    RevealBatch public pendingReveal;
    bytes32 public revealSeed;

    bool public claimRequired;
    address public claimSigner;
    address public treasury;
    address public escrow;
    string public imageBaseURI;
    bool public imageBaseURIFrozen;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event AgentMinted(uint256 indexed agentId, address indexed owner, address tba);
    event RevealRequested(uint64 indexed sequence, uint256 firstAgentId, uint256 lastAgentId, bool retry);
    event RevealSeedStored(uint64 indexed sequence, bytes32 seed);
    event AgentRevealed(uint256 indexed agentId, uint8 tier, uint8 species);
    event OwnerEpochBumped(uint256 indexed agentId, uint64 epoch, address indexed from, address indexed to);
    event ClaimRequiredSet(bool required);
    event ClaimSignerSet(address indexed previousSigner, address indexed newSigner);
    event ImageBaseURISet(string uri);
    event ImageBaseURIFrozen(string uri);
    event TreasurySet(address indexed previousTreasury, address indexed newTreasury);
    event EscrowSet(address indexed escrow);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error AlreadyMinted(address wallet);
    error SoldOut();
    error ClaimIsRequired();
    error ClaimExpired(uint64 deadline);
    error ClaimNonceUsed(bytes32 nonce);
    error InvalidClaimSigner(address recovered);
    error AccountNotCanonical(address tba, address implementation);
    error TransfersRestricted();
    error TransferToAgentAccount(address to);
    error NothingToReveal();
    error RevealPending(uint64 sequence);
    error InsufficientRevealFee(uint256 sent, uint256 fee);
    error RefundFailed();
    error NotEntropy(address caller);
    error NoSeed();
    error ZeroAddress();
    error EscrowAlreadySet(address escrow);
    error EscrowNotContract(address escrow);
    error ImageBaseURIIsFrozen();
    error InvalidImageBaseURI();
    error RenounceDisabled();

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(
        address admin,
        address claimSigner_,
        address treasury_,
        string memory imageBaseURI_,
        IERC6551Registry accountRegistry,
        address accountProxy,
        address accountImplementation,
        IEntropyV2 entropy
    ) ERC721("Alpha Agents", "AGENT") Ownable(admin) EIP712("AlphaAgents AgentNFT", "1") {
        if (
            claimSigner_ == address(0) || treasury_ == address(0) || address(accountRegistry) == address(0)
                || accountProxy == address(0) || accountImplementation == address(0) || address(entropy) == address(0)
        ) revert ZeroAddress();
        ACCOUNT_REGISTRY = accountRegistry;
        ACCOUNT_PROXY = accountProxy;
        ACCOUNT_IMPLEMENTATION = accountImplementation;
        ENTROPY = entropy;

        claimRequired = true;
        claimSigner = claimSigner_;
        treasury = treasury_;
        _setDefaultRoyalty(treasury_, ROYALTY_BPS);
        _checkImageBaseURI(imageBaseURI_);
        imageBaseURI = imageBaseURI_;

        emit ClaimRequiredSet(true);
        emit ClaimSignerSet(address(0), claimSigner_);
        emit TreasurySet(address(0), treasury_);
        emit ImageBaseURISet(imageBaseURI_);
    }

    // ---------------------------------------------------------------------
    // Mint
    // ---------------------------------------------------------------------

    /// Mints the caller's one agent while claim-required mode is off.
    function mint() external returns (uint256 agentId) {
        if (claimRequired) revert ClaimIsRequired();
        return _mintAgent(msg.sender);
    }

    /// Mints the caller's one agent with a claim signed by the platform signer.
    /// Works in either mode; the claim names the caller, so it cannot be used
    /// by another wallet, and its nonce works once.
    function mintWithClaim(uint64 deadline, bytes32 nonce, bytes calldata signature)
        external
        returns (uint256 agentId)
    {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert ClaimExpired(deadline);
        if (claimNonceUsed[nonce]) revert ClaimNonceUsed(nonce);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, msg.sender, nonce, deadline)));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != claimSigner) revert InvalidClaimSigner(recovered);
        claimNonceUsed[nonce] = true;
        return _mintAgent(msg.sender);
    }

    function _mintAgent(address to) internal returns (uint256 agentId) {
        if (hasMinted[to]) revert AlreadyMinted(to);
        if (totalMinted >= MAX_SUPPLY) revert SoldOut();
        hasMinted[to] = true;
        agentId = ++totalMinted;
        // Timestamps fit in 64 bits for billions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
        _agents[agentId].epochStartedAt = uint64(block.timestamp);
        // _mint, not _safeMint: the minter is the caller, and no receiver hook
        // runs in the middle of the mint.
        _mint(to, agentId);
        address tba = _createAccount(agentId);
        // The calls above go only to the canonical registry and account.
        // forge-lint: disable-next-line(reentrancy-events)
        emit AgentMinted(agentId, to, tba);
    }

    /// Creates and initializes the agent's Tokenbound account in this
    /// transaction. Anyone can create or initialize an account ahead of the
    /// mint (both are permissionless), so a failed `initialize` is tolerated
    /// and the implementation slot is checked instead.
    function _createAccount(uint256 agentId) internal returns (address tba) {
        tba = ACCOUNT_REGISTRY.createAccount(ACCOUNT_PROXY, bytes32(0), block.chainid, address(this), agentId);
        try ITokenboundAccount(tba).initialize(ACCOUNT_IMPLEMENTATION) {} catch {}
        address implementation = address(uint160(uint256(ITokenboundAccount(tba).extsload(IMPLEMENTATION_SLOT))));
        if (implementation != ACCOUNT_IMPLEMENTATION) revert AccountNotCanonical(tba, implementation);
    }

    // ---------------------------------------------------------------------
    // Reveal (D-187, evidence/p1-u3/RANDOMNESS.md)
    // ---------------------------------------------------------------------

    /// Requests randomness for every agent minted so far and not yet revealed.
    /// Anyone can call it and pays the Entropy fee; any excess is refunded.
    /// A pending request can only be replaced if its number has not arrived
    /// within REVEAL_TIMEOUT; the batch stays the same.
    function requestReveal() external payable returns (uint64 sequence) {
        RevealBatch memory batch = pendingReveal;
        bool retry = false;
        if (batch.sequence != 0) {
            // Seconds of leader skew do not matter against a one-hour timeout.
            // forge-lint: disable-next-line(block-timestamp)
            if (batch.seedReady || block.timestamp < batch.requestedAt + REVEAL_TIMEOUT) {
                revert RevealPending(batch.sequence);
            }
            retry = true;
        } else {
            if (nextToReveal > totalMinted) revert NothingToReveal();
            batch.batchLast = totalMinted;
        }

        uint256 fee = ENTROPY.getFeeV2();
        if (msg.value < fee) revert InsufficientRevealFee(msg.value, fee);
        sequence = ENTROPY.requestV2{value: fee}();

        // The request must exist before its sequence is known, so the state
        // write follows the call to Entropy (a fixed, trusted contract).
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 requestedAt = uint64(block.timestamp);
        pendingReveal =
            RevealBatch({sequence: sequence, requestedAt: requestedAt, batchLast: batch.batchLast, seedReady: false});
        // forge-lint: disable-next-line(reentrancy-events)
        emit RevealRequested(sequence, nextToReveal, batch.batchLast, retry);

        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// Called by Entropy with the random number. It only stores the number for
    /// the pending request and never reverts for any other reason, so the
    /// callback cannot be made to fail. Numbers for replaced requests are ignored.
    function _entropyCallback(uint64 sequence, address, bytes32 randomNumber) external {
        if (msg.sender != address(ENTROPY)) revert NotEntropy(msg.sender);
        RevealBatch storage batch = pendingReveal;
        if (sequence != batch.sequence || batch.seedReady) return;
        bytes32 seed = keccak256(abi.encode(randomNumber, sequence, block.chainid, address(this)));
        revealSeed = seed;
        batch.seedReady = true;
        emit RevealSeedStored(sequence, seed);
    }

    /// Applies the stored number to up to `maxCount` agents of the batch, in
    /// mint order. Anyone can call it; the result does not depend on who calls
    /// it, when, or in how many chunks.
    function reveal(uint256 maxCount) external returns (uint256 revealed) {
        RevealBatch memory batch = pendingReveal;
        if (!batch.seedReady) revert NoSeed();
        bytes32 seed = revealSeed;
        uint256 next = nextToReveal;
        uint256 last = batch.batchLast;
        uint256 deck = _deck;
        uint256 remaining = MAX_SUPPLY - (next - 1);

        while (next <= last && revealed < maxCount) {
            uint256 draw = uint256(keccak256(abi.encode(seed, next))) % remaining;
            uint8 species = _speciesAt(deck, draw);
            deck -= uint256(1) << (8 * uint256(species - 1));
            unchecked {
                --remaining;
            }
            _agents[next].species = species;
            emit AgentRevealed(next, _tierOf(species), species);
            emit MetadataUpdate(next);
            unchecked {
                ++next;
                ++revealed;
            }
        }

        _deck = deck;
        // `next` is at most MAX_SUPPLY + 1.
        // forge-lint: disable-next-line(unsafe-typecast)
        nextToReveal = uint16(next);
        if (next > last) {
            delete pendingReveal;
            delete revealSeed;
        }
    }

    /// The species whose slots cover position `draw` among the remaining slots.
    function _speciesAt(uint256 deck, uint256 draw) internal pure returns (uint8) {
        for (uint8 s = 0; s < SPECIES_COUNT; ++s) {
            uint256 count = (deck >> (8 * uint256(s))) & 0xff;
            if (draw < count) return s + 1;
            draw -= count;
        }
        // Unreachable: `draw` is below the sum of the remaining counts.
        // forge-lint: disable-next-line(require-revert-in-loop)
        revert SoldOut();
    }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    function totalSupply() external view returns (uint256) {
        return totalMinted;
    }

    function isRevealed(uint256 agentId) public view returns (bool) {
        _requireOwned(agentId);
        return _agents[agentId].species != 0;
    }

    /// 0 while unrevealed, then 1 to 25.
    function speciesOf(uint256 agentId) public view returns (uint8) {
        _requireOwned(agentId);
        return _agents[agentId].species;
    }

    /// 0 while unrevealed, then TIER_BASE, TIER_MEDIUM or TIER_PRO.
    function tierOf(uint256 agentId) public view returns (uint8) {
        return _tierOf(speciesOf(agentId));
    }

    /// Skill slots by tier (3, 5, 8), 0 while unrevealed.
    function slotsOf(uint256 agentId) external view returns (uint8) {
        uint8 tier = tierOf(agentId);
        if (tier == TIER_BASE) return 3;
        if (tier == TIER_MEDIUM) return 5;
        if (tier == TIER_PRO) return 8;
        return 0;
    }

    function ownerEpoch(uint256 agentId) external view returns (uint64) {
        _requireOwned(agentId);
        return _agents[agentId].ownerEpoch;
    }

    function epochStartedAt(uint256 agentId) external view returns (uint64) {
        _requireOwned(agentId);
        return _agents[agentId].epochStartedAt;
    }

    /// The agent's Tokenbound account (created at mint).
    function tbaOf(uint256 agentId) public view returns (address) {
        _requireOwned(agentId);
        return ACCOUNT_REGISTRY.account(ACCOUNT_PROXY, bytes32(0), block.chainid, address(this), agentId);
    }

    /// The remaining slots of a species, 1 to 25.
    function remainingOf(uint8 species) external view returns (uint256) {
        if (species == 0 || species > SPECIES_COUNT) return 0;
        return (_deck >> (8 * uint256(species - 1))) & 0xff;
    }

    /// Unrevealed slots left in the deck (1,000 minus revealed agents).
    function remainingSupply() external view returns (uint256) {
        return MAX_SUPPLY - (nextToReveal - 1);
    }

    function _tierOf(uint8 species) internal pure returns (uint8) {
        if (species == 0) return 0;
        if (species <= 5) return TIER_BASE;
        if (species <= 13) return TIER_MEDIUM;
        return TIER_PRO;
    }

    // ---------------------------------------------------------------------
    // Metadata (D-181, D-186)
    // ---------------------------------------------------------------------

    function tokenURI(uint256 agentId) public view override returns (string memory) {
        _requireOwned(agentId);
        uint8 species = _agents[agentId].species;
        string memory attributes;
        string memory image;
        if (species == 0) {
            attributes = '[{"trait_type":"Status","value":"Unrevealed"}]';
            image = string.concat(imageBaseURI, "unrevealed.png");
        } else {
            (string memory name, string memory slug) = speciesInfo(species);
            attributes = string.concat(
                '[{"trait_type":"Tier","value":"',
                _tierName(_tierOf(species)),
                '"},{"trait_type":"Species","value":"',
                name,
                '"},{"trait_type":"Status","value":"Revealed"}]'
            );
            image = string.concat(imageBaseURI, slug, ".png");
        }
        string memory json = string.concat(
            '{"name":"Alpha Agent #',
            agentId.toString(),
            '","description":"An Alpha Agents AI agent on Monad.","image":"',
            image,
            '","attributes":',
            attributes,
            "}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _tierName(uint8 tier) internal pure returns (string memory) {
        if (tier == TIER_BASE) return "Base";
        if (tier == TIER_MEDIUM) return "Medium";
        return "Pro";
    }

    /// Display name and image slug of a species, 1 to 25. The table must match
    /// packages/domain/src/species.ts (species.test.ts checks this source).
    function speciesInfo(uint8 s) public pure returns (string memory name, string memory slug) {
        // SPECIES TABLE START
        if (s == 1) return ("Larva grub", "larva-grub");
        if (s == 2) return ("Roly-poly", "roly-poly");
        if (s == 3) return ("Ant", "ant");
        if (s == 4) return ("Tick", "tick");
        if (s == 5) return ("Weevil", "weevil");
        if (s == 6) return ("Silkworm", "silkworm");
        if (s == 7) return ("Ground beetle", "ground-beetle");
        if (s == 8) return ("Cricket", "cricket");
        if (s == 9) return ("Moth", "moth");
        if (s == 10) return ("Firefly", "firefly");
        if (s == 11) return ("Centipede", "centipede");
        if (s == 12) return ("Water strider", "water-strider");
        if (s == 13) return ("Earwig", "earwig");
        if (s == 14) return ("Bee", "bee");
        if (s == 15) return ("Praying mantis", "praying-mantis");
        if (s == 16) return ("Hercules beetle", "hercules-beetle");
        if (s == 17) return ("Horseshoe crab", "horseshoe-crab");
        if (s == 18) return ("Jumping spider", "jumping-spider");
        if (s == 19) return ("Mantis shrimp", "mantis-shrimp");
        if (s == 20) return ("Dragonfly", "dragonfly");
        if (s == 21) return ("Scorpion", "scorpion");
        if (s == 22) return ("Trilobite", "trilobite");
        if (s == 23) return ("Stag beetle", "stag-beetle");
        if (s == 24) return ("Atlas moth", "atlas-moth");
        if (s == 25) return ("Cicada", "cicada");
        // SPECIES TABLE END
        return ("", "");
    }

    // ---------------------------------------------------------------------
    // Transfers
    // ---------------------------------------------------------------------

    /// Every ownership change passes here. Minting is the only path with no
    /// previous owner; there is no burn. Any other move must be made by the
    /// escrow, can never go to an agent account, and bumps the epoch.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0)) {
            if (escrow == address(0) || msg.sender != escrow) revert TransfersRestricted();
            if (_isAgentAccount(to)) revert TransferToAgentAccount(to);
            Agent storage agent = _agents[tokenId];
            uint64 epoch = agent.ownerEpoch + 1;
            agent.ownerEpoch = epoch;
            // forge-lint: disable-next-line(unsafe-typecast)
            agent.epochStartedAt = uint64(block.timestamp);
            // The only external call above is the bounded `token()` view.
            // forge-lint: disable-next-line(reentrancy-events)
            emit OwnerEpochBumped(tokenId, epoch, from, to);
        }
        return super._update(to, tokenId, auth);
    }

    /// True if `to` is an ERC-6551 account bound to one of our agents.
    function _isAgentAccount(address to) internal view returns (bool) {
        if (to.code.length == 0) return false;
        try ITokenboundAccount(to).token{gas: 50_000}() returns (uint256, address tokenContract, uint256) {
            return tokenContract == address(this);
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------------
    // Admin: exactly these powers and no others
    // ---------------------------------------------------------------------

    function setClaimRequired(bool required) external onlyOwner {
        claimRequired = required;
        emit ClaimRequiredSet(required);
    }

    function setClaimSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit ClaimSignerSet(claimSigner, newSigner);
        claimSigner = newSigner;
    }

    function setImageBaseURI(string calldata uri) external onlyOwner {
        if (imageBaseURIFrozen) revert ImageBaseURIIsFrozen();
        _checkImageBaseURI(uri);
        imageBaseURI = uri;
        emit ImageBaseURISet(uri);
        emit BatchMetadataUpdate(1, MAX_SUPPLY);
    }

    /// Freezes the image base link forever.
    function freezeImageBaseURI() external onlyOwner {
        if (imageBaseURIFrozen) revert ImageBaseURIIsFrozen();
        imageBaseURIFrozen = true;
        emit ImageBaseURIFrozen(imageBaseURI);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasurySet(treasury, newTreasury);
        treasury = newTreasury;
        _setDefaultRoyalty(newTreasury, ROYALTY_BPS);
    }

    /// Sets the marketplace escrow, once. Until then only minting moves tokens.
    function setEscrow(address escrow_) external onlyOwner {
        if (escrow != address(0)) revert EscrowAlreadySet(escrow);
        if (escrow_ == address(0)) revert ZeroAddress();
        if (escrow_.code.length == 0) revert EscrowNotContract(escrow_);
        escrow = escrow_;
        emit EscrowSet(escrow_);
    }

    /// Disabled: without an admin, the escrow could never be set.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// The image base link must be non-empty, end with "/", and contain no
    /// character that would break the JSON built in tokenURI.
    function _checkImageBaseURI(string memory uri) internal pure {
        bytes memory b = bytes(uri);
        if (b.length == 0 || b.length > MAX_IMAGE_BASE_URI_LENGTH || b[b.length - 1] != "/") {
            revert InvalidImageBaseURI();
        }
        for (uint256 i = 0; i < b.length; ++i) {
            bytes1 c = b[i];
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (c < 0x21 || c > 0x7e || c == '"' || c == "\\") revert InvalidImageBaseURI();
        }
    }

    // ---------------------------------------------------------------------
    // Interfaces
    // ---------------------------------------------------------------------

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981, IERC165) returns (bool) {
        return interfaceId == bytes4(0x49064906) || ERC721.supportsInterface(interfaceId)
            || ERC2981.supportsInterface(interfaceId);
    }
}
