// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// CO-U1: an agent's copy on Base or Arbitrum. Agents are minted on Monad; on these chains the
/// platform, after checking the Monad owner, mints the same agent (the same id, tier and species)
/// to that owner. No cross-chain messaging: the minter is the platform, and only it moves a copy,
/// when the Monad agent changes hands. The trading set reads `ownerOf` and `ownerEpoch`, as on
/// AgentNFT, and the events are AgentNFT's, so the indexer reads a copy as it reads an agent.
contract AgentCopyNFT is ERC721, Ownable {
    using Strings for uint256;

    struct Copy {
        uint8 tier;
        uint8 species;
        uint64 ownerEpoch;
    }

    mapping(uint256 => Copy) private _copies;
    address public minter;
    string public imageBaseURI;

    event AgentMinted(uint256 indexed agentId, address indexed owner, address tba);
    event AgentRevealed(uint256 indexed agentId, uint8 tier, uint8 species);
    event OwnerEpochBumped(uint256 indexed agentId, uint64 epoch, address indexed from, address indexed to);
    event MinterSet(address indexed previousMinter, address indexed newMinter);

    error NotMinter(address caller);
    error TransfersRestricted();
    error BadCopy();

    constructor(address admin, address minter_, string memory imageBaseURI_)
        ERC721("Vivarium Agent", "VIVA")
        Ownable(admin)
    {
        minter = minter_;
        imageBaseURI = imageBaseURI_;
        emit MinterSet(address(0), minter_);
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter(msg.sender);
        _;
    }

    function setMinter(address minter_) external onlyOwner {
        emit MinterSet(minter, minter_);
        minter = minter_;
    }

    /// Mints the copy of Monad agent `agentId` to its Monad owner, revealed at once.
    function mintCopy(address to, uint256 agentId, uint8 tier, uint8 species) external onlyMinter {
        if (agentId == 0 || species == 0 || tier == 0) revert BadCopy();
        _copies[agentId] = Copy({tier: tier, species: species, ownerEpoch: 0});
        _mint(to, agentId);
        // No token-bound account here; a unique address that never moves funds stands in.
        emit AgentMinted(agentId, to, address(uint160(uint256(keccak256(abi.encode("vivarium.copy", agentId))))));
        emit AgentRevealed(agentId, tier, species);
    }

    /// Follows the Monad agent to its new owner; the epoch bump voids the old owner's grants.
    function moveCopy(uint256 agentId, address to) external onlyMinter {
        address from = _requireOwned(agentId);
        uint64 epoch = ++_copies[agentId].ownerEpoch;
        emit OwnerEpochBumped(agentId, epoch, from, to);
        _update(to, agentId, address(0));
    }

    function ownerEpoch(uint256 agentId) external view returns (uint64) {
        _requireOwned(agentId);
        return _copies[agentId].ownerEpoch;
    }

    function copyOf(uint256 agentId) external view returns (uint8 tier, uint8 species) {
        _requireOwned(agentId);
        Copy memory c = _copies[agentId];
        return (c.tier, c.species);
    }

    function tokenURI(uint256 agentId) public view override returns (string memory) {
        _requireOwned(agentId);
        Copy memory c = _copies[agentId];
        return string.concat(
            'data:application/json;utf8,{"name":"Vivarium Agent #',
            agentId.toString(),
            '","image":"',
            imageBaseURI,
            uint256(c.species).toString(),
            '.png","attributes":[{"trait_type":"Tier","value":',
            uint256(c.tier).toString(),
            '},{"trait_type":"Species","value":',
            uint256(c.species).toString(),
            "}]}"
        );
    }

    /// Only the minter moves a copy (moveCopy); owners cannot transfer or approve one.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0) && msg.sender != minter) revert TransfersRestricted();
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert TransfersRestricted();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert TransfersRestricted();
    }
}
