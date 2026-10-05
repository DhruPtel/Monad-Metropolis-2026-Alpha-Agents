// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Vm} from "forge-std/Vm.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {IERC6551Registry, IEntropyV2} from "../src/interfaces/IExternal.sol";
import {AgentNFTBase} from "./AgentNFTBase.sol";
import {MockAccount} from "./mocks/AgentNFTMocks.sol";

contract AgentNFTMintTest is AgentNFTBase {
    function test_StartsClaimRequiredWithSignerTreasuryAndNoEscrow() public view {
        assertTrue(nft.claimRequired());
        assertEq(nft.claimSigner(), signer.addr);
        assertEq(nft.treasury(), treasury);
        assertEq(nft.escrow(), address(0));
        assertEq(nft.owner(), admin);
        assertEq(nft.totalMinted(), 0);
        assertEq(nft.MAX_SUPPLY(), 1000);
        assertEq(nft.name(), "Alpha Agents");
        assertEq(nft.symbol(), "AGENT");
    }

    function test_ConstructorRejectsZeroAddresses() public {
        // Read the getters first: expectRevert applies to the next call.
        IERC6551Registry reg = nft.ACCOUNT_REGISTRY();
        IEntropyV2 ent = nft.ENTROPY();
        vm.expectRevert(AgentNFT.ZeroAddress.selector);
        new AgentNFT(admin, address(0), treasury, IMAGE_BASE, reg, ACCOUNT_PROXY, ACCOUNT_IMPLEMENTATION, ent);
        vm.expectRevert(AgentNFT.ZeroAddress.selector);
        new AgentNFT(admin, signer.addr, address(0), IMAGE_BASE, reg, ACCOUNT_PROXY, ACCOUNT_IMPLEMENTATION, ent);
        vm.expectRevert(AgentNFT.ZeroAddress.selector);
        new AgentNFT(admin, signer.addr, treasury, IMAGE_BASE, reg, address(0), ACCOUNT_IMPLEMENTATION, ent);
        vm.expectRevert(AgentNFT.InvalidImageBaseURI.selector);
        new AgentNFT(admin, signer.addr, treasury, "ipfs://x", reg, ACCOUNT_PROXY, ACCOUNT_IMPLEMENTATION, ent);
    }

    function test_MintCreatesUnrevealedAgentWithAccountAndEvent() public {
        address wallet = freshWallet();
        address expectedTba = registry.account(ACCOUNT_PROXY, bytes32(0), block.chainid, address(nft), 1);
        vm.expectEmit(address(nft));
        emit AgentNFT.AgentMinted(1, wallet, expectedTba);
        uint256 id = mintWithValidClaim(wallet);

        assertEq(id, 1);
        assertEq(nft.ownerOf(1), wallet);
        assertEq(nft.totalMinted(), 1);
        assertEq(nft.totalSupply(), 1);
        assertTrue(nft.hasMinted(wallet));
        assertFalse(nft.isRevealed(1));
        assertEq(nft.speciesOf(1), 0);
        assertEq(nft.tierOf(1), 0);
        assertEq(nft.slotsOf(1), 0);
        assertEq(nft.ownerEpoch(1), 0);
        assertEq(nft.epochStartedAt(1), block.timestamp);
        assertEq(nft.tbaOf(1), expectedTba);
        assertGt(expectedTba.code.length, 0, "account deployed in the mint transaction");
        assertEq(
            address(
                uint160(
                    uint256(
                        MockAccount(expectedTba)
                            .extsload(bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1))
                    )
                )
            ),
            ACCOUNT_IMPLEMENTATION,
            "account initialized in the mint transaction"
        );
    }

    function test_MintIsFree() public {
        address wallet = freshWallet();
        uint256 before = wallet.balance;
        mintWithValidClaim(wallet);
        assertEq(wallet.balance, before);
        assertEq(address(nft).balance, 0);
    }

    function test_OneMintPerWallet() public {
        address wallet = freshWallet();
        mintWithValidClaim(wallet);
        bytes32 nonce = keccak256("second nonce");
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = signClaim(signer.privateKey, wallet, nonce, deadline);
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.AlreadyMinted.selector, wallet));
        nft.mintWithClaim(deadline, nonce, sig);

        openMint();
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.AlreadyMinted.selector, wallet));
        nft.mint();
    }

    function test_OpenMintWorksWhenClaimModeOffAndIsStillOnePerWallet() public {
        address wallet = freshWallet();
        vm.prank(wallet);
        vm.expectRevert(AgentNFT.ClaimIsRequired.selector);
        nft.mint();

        openMint();
        vm.prank(wallet);
        assertEq(nft.mint(), 1);
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.AlreadyMinted.selector, wallet));
        nft.mint();
    }

    function test_ClaimStillWorksWhenClaimModeOff() public {
        openMint();
        assertEq(mintWithValidClaim(freshWallet()), 1);
    }

    function test_HardCapOf1000() public {
        openMint();
        mintMany(1000);
        assertEq(nft.totalMinted(), 1000);
        address late = freshWallet();
        vm.prank(late);
        vm.expectRevert(AgentNFT.SoldOut.selector);
        nft.mint();

        bytes32 nonce = keccak256("late");
        uint64 deadline = uint64(block.timestamp + 1);
        bytes memory sig = signClaim(signer.privateKey, late, nonce, deadline);
        vm.prank(late);
        vm.expectRevert(AgentNFT.SoldOut.selector);
        nft.mintWithClaim(deadline, nonce, sig);
    }

    function test_MintSucceedsWhenSomeoneCreatedAndInitializedTheAccountFirst() public {
        // Both are permissionless, so an attacker can front-run them.
        address tba = registry.createAccount(ACCOUNT_PROXY, bytes32(0), block.chainid, address(nft), 1);
        MockAccount(tba).initialize(ACCOUNT_IMPLEMENTATION);
        address wallet = freshWallet();
        assertEq(mintWithValidClaim(wallet), 1);
        assertEq(nft.tbaOf(1), tba);
        assertEq(nft.ownerOf(1), wallet);
    }

    function test_MintReturnsSequentialIds() public {
        openMint();
        for (uint256 i = 1; i <= 5; ++i) {
            vm.prank(freshWallet());
            assertEq(nft.mint(), i);
        }
    }

    /// forge-config: default.fuzz.runs = 12
    function testFuzz_MintNeverExceedsCap(uint16 n) public {
        n = uint16(bound(n, 0, 1100));
        openMint();
        uint256 ok;
        for (uint256 i = 0; i < n; ++i) {
            vm.prank(freshWallet());
            try nft.mint() {
                ++ok;
            } catch {}
        }
        assertEq(ok, n > 1000 ? 1000 : n);
        assertLe(nft.totalMinted(), 1000);
    }
}

contract AgentNFTClaimTest is AgentNFTBase {
    address internal wallet;
    bytes32 internal nonce = keccak256("claim nonce");
    uint64 internal deadline;

    function setUp() public override {
        super.setUp();
        wallet = freshWallet();
        deadline = uint64(block.timestamp + 10 minutes);
    }

    function test_ValidClaimIsAccepted() public {
        bytes memory sig = signClaim(signer.privateKey, wallet, nonce, deadline);
        vm.prank(wallet);
        assertEq(nft.mintWithClaim(deadline, nonce, sig), 1);
        assertTrue(nft.claimNonceUsed(nonce));
    }

    function test_ClaimIsAcceptedAtItsDeadline() public {
        bytes memory sig = signClaim(signer.privateKey, wallet, nonce, deadline);
        vm.warp(deadline);
        vm.prank(wallet);
        assertEq(nft.mintWithClaim(deadline, nonce, sig), 1);
    }

    function test_ExpiredClaimIsRejected() public {
        bytes memory sig = signClaim(signer.privateKey, wallet, nonce, deadline);
        vm.warp(uint256(deadline) + 1);
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.ClaimExpired.selector, deadline));
        nft.mintWithClaim(deadline, nonce, sig);
    }

    function test_ReplayedClaimIsRejected() public {
        bytes memory sig = signClaim(signer.privateKey, wallet, nonce, deadline);
        vm.prank(wallet);
        nft.mintWithClaim(deadline, nonce, sig);
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.ClaimNonceUsed.selector, nonce));
        nft.mintWithClaim(deadline, nonce, sig);
    }

    function test_NonceCannotBeReusedForAnotherWallet() public {
        bytes memory sig = signClaim(signer.privateKey, wallet, nonce, deadline);
        vm.prank(wallet);
        nft.mintWithClaim(deadline, nonce, sig);
        address other = freshWallet();
        bytes memory otherSig = signClaim(signer.privateKey, other, nonce, deadline);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.ClaimNonceUsed.selector, nonce));
        nft.mintWithClaim(deadline, nonce, otherSig);
    }

    function test_WrongSignerIsRejected() public {
        Vm.Wallet memory impostor = vm.createWallet("impostor");
        bytes memory sig = signClaim(impostor.privateKey, wallet, nonce, deadline);
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.InvalidClaimSigner.selector, impostor.addr));
        nft.mintWithClaim(deadline, nonce, sig);
    }

    function test_ClaimForAnotherWalletIsRejected() public {
        bytes memory sig = signClaim(signer.privateKey, wallet, nonce, deadline);
        address thief = freshWallet();
        vm.prank(thief);
        vm.expectPartialRevert(AgentNFT.InvalidClaimSigner.selector);
        nft.mintWithClaim(deadline, nonce, sig);
        assertFalse(nft.claimNonceUsed(nonce));
    }

    function test_AlteredDeadlineIsRejected() public {
        bytes memory sig = signClaim(signer.privateKey, wallet, nonce, deadline);
        vm.prank(wallet);
        vm.expectPartialRevert(AgentNFT.InvalidClaimSigner.selector);
        nft.mintWithClaim(deadline + 1 days, nonce, sig);
    }

    function test_MalformedSignatureIsRejected() public {
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.InvalidClaimSigner.selector, address(0)));
        nft.mintWithClaim(deadline, nonce, hex"1234");
    }

    function test_ClaimFromRotatedOutSignerIsRejected() public {
        bytes memory sig = signClaim(signer.privateKey, wallet, nonce, deadline);
        vm.prank(admin);
        nft.setClaimSigner(makeAddr("new signer"));
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.InvalidClaimSigner.selector, signer.addr));
        nft.mintWithClaim(deadline, nonce, sig);
    }
}

contract AgentNFTTransferTest is AgentNFTBase {
    address internal alice;
    address internal bob;

    function setUp() public override {
        super.setUp();
        openMint();
        alice = freshWallet();
        bob = freshWallet();
        vm.prank(alice);
        nft.mint();
        vm.prank(bob);
        nft.mint();
    }

    function test_TransfersFailUntilEscrowIsSet() public {
        vm.startPrank(alice);
        vm.expectRevert(AgentNFT.TransfersRestricted.selector);
        nft.transferFrom(alice, bob, 1);
        vm.expectRevert(AgentNFT.TransfersRestricted.selector);
        nft.safeTransferFrom(alice, bob, 1);
        vm.expectRevert(AgentNFT.TransfersRestricted.selector);
        nft.safeTransferFrom(alice, bob, 1, "");
        nft.approve(address(escrow), 1);
        vm.stopPrank();
        vm.expectRevert(AgentNFT.TransfersRestricted.selector);
        escrow.move(nft, alice, bob, 1);
    }

    function test_OnlyTheEscrowCanTransferOnceSet() public {
        setEscrow();
        vm.startPrank(alice);
        nft.setApprovalForAll(bob, true);
        vm.expectRevert(AgentNFT.TransfersRestricted.selector);
        nft.transferFrom(alice, bob, 1);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(AgentNFT.TransfersRestricted.selector);
        nft.transferFrom(alice, bob, 1);

        escrowMove(1, bob);
        assertEq(nft.ownerOf(1), bob);
    }

    function test_EscrowStillNeedsApproval() public {
        setEscrow();
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, address(escrow), 1));
        escrow.move(nft, alice, bob, 1);
    }

    function test_EpochIncrementsOnEveryTransfer() public {
        setEscrow();
        address carol = freshWallet();
        uint64 expected;
        address[4] memory path = [address(escrow), bob, carol, alice];
        uint256 t = 1_800_000_000;
        for (uint256 i = 0; i < path.length; ++i) {
            t += 1 days;
            vm.warp(t);
            address from = nft.ownerOf(1);
            ++expected;
            if (from != address(escrow)) {
                vm.prank(from);
                nft.approve(address(escrow), 1);
            }
            vm.expectEmit(address(nft));
            emit AgentNFT.OwnerEpochBumped(1, expected, from, path[i]);
            escrow.move(nft, from, path[i], 1);
            assertEq(nft.ownerEpoch(1), expected);
            assertEq(nft.epochStartedAt(1), t);
        }
        // Back to the first owner, with a new epoch: old authority never revives.
        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.ownerEpoch(1), 4);
        assertEq(nft.ownerEpoch(2), 0, "other agents keep their epoch");
    }

    function test_SafeTransferByEscrowBumpsEpoch() public {
        setEscrow();
        vm.prank(alice);
        nft.approve(address(escrow), 1);
        escrow.safeMove(nft, alice, bob, 1);
        assertEq(nft.ownerEpoch(1), 1);
    }

    function test_WalletMayHoldSeveralAgentsButMintOnlyOnce() public {
        setEscrow();
        escrowMove(1, bob);
        assertEq(nft.balanceOf(bob), 2);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.AlreadyMinted.selector, bob));
        nft.mint();

        // A wallet that received an agent but never minted can still mint.
        address carol = freshWallet();
        escrowMove(2, carol);
        vm.prank(carol);
        assertEq(nft.mint(), 3);
        assertEq(nft.balanceOf(carol), 2);
    }

    function test_CannotTransferToAnAgentAccount() public {
        setEscrow();
        address bobTba = nft.tbaOf(2);
        vm.prank(alice);
        nft.approve(address(escrow), 1);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.TransferToAgentAccount.selector, bobTba));
        escrow.move(nft, alice, bobTba, 1);

        address ownTba = nft.tbaOf(1);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.TransferToAgentAccount.selector, ownTba));
        escrow.move(nft, alice, ownTba, 1);
    }

    function test_CannotTransferToZeroAddress() public {
        setEscrow();
        vm.prank(alice);
        nft.approve(address(escrow), 1);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(0)));
        escrow.move(nft, alice, address(0), 1);
    }

    function test_HasNoBurn() public view {
        (bool found,) = _hasFunction("burn(uint256)");
        assertFalse(found);
    }

    function _hasFunction(string memory sig) internal view returns (bool, bytes memory) {
        (bool ok, bytes memory data) = address(nft).staticcall(abi.encodeWithSignature(sig, 1));
        return (ok, data);
    }
}

contract AgentNFTMetadataTest is AgentNFTBase {
    using stdJson for string;

    function setUp() public override {
        super.setUp();
        openMint();
    }

    function _json(uint256 id) internal view returns (string memory) {
        string memory uri = nft.tokenURI(id);
        string memory prefix = "data:application/json;base64,";
        assertEq(_slice(uri, 0, bytes(prefix).length), prefix);
        return string(_base64Decode(_slice(uri, bytes(prefix).length, bytes(uri).length)));
    }

    function test_UnrevealedTokenURIIsValidJsonWithPlaceholder() public {
        vm.prank(freshWallet());
        nft.mint();
        string memory json = _json(1);
        assertEq(
            json,
            '{"name":"Alpha Agent #1","description":"An Alpha Agents AI agent on Monad.","image":"ipfs://bafyimages/unrevealed.png","attributes":[{"trait_type":"Status","value":"Unrevealed"}]}'
        );
        assertEq(json.readString(".name"), "Alpha Agent #1");
        assertEq(json.readString(".image"), "ipfs://bafyimages/unrevealed.png");
        assertEq(json.readString(".attributes[0].value"), "Unrevealed");
    }

    function test_RevealedTokenURIHasTierSpeciesAndImage() public {
        mintMany(30);
        revealBatch(keccak256("metadata"));
        for (uint256 id = 1; id <= 30; ++id) {
            uint8 species = nft.speciesOf(id);
            (string memory name, string memory slug) = nft.speciesInfo(species);
            string memory tier = species <= 5 ? "Base" : species <= 13 ? "Medium" : "Pro";
            string memory json = _json(id);
            assertEq(json.readString(".name"), string.concat("Alpha Agent #", vm.toString(id)));
            assertEq(json.readString(".image"), string.concat(IMAGE_BASE, slug, ".png"));
            assertEq(json.readString(".attributes[0].trait_type"), "Tier");
            assertEq(json.readString(".attributes[0].value"), tier);
            assertEq(json.readString(".attributes[1].trait_type"), "Species");
            assertEq(json.readString(".attributes[1].value"), name);
            assertEq(json.readString(".attributes[2].value"), "Revealed");
        }
    }

    function test_EverySpeciesHasANameAndSlug() public view {
        for (uint8 s = 1; s <= 25; ++s) {
            (string memory name, string memory slug) = nft.speciesInfo(s);
            assertGt(bytes(name).length, 0);
            assertGt(bytes(slug).length, 0);
        }
        (string memory none,) = nft.speciesInfo(26);
        assertEq(bytes(none).length, 0);
    }

    function test_TokenURIRevertsForUnmintedAgent() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 7));
        nft.tokenURI(7);
    }

    function test_AdminCanChangeImageLinkUntilFrozen() public {
        vm.prank(freshWallet());
        nft.mint();
        vm.startPrank(admin);
        vm.expectEmit(address(nft));
        emit AgentNFT.ImageBaseURISet("ipfs://bafynew/");
        nft.setImageBaseURI("ipfs://bafynew/");
        assertEq(_json(1).readString(".image"), "ipfs://bafynew/unrevealed.png");

        vm.expectEmit(address(nft));
        emit AgentNFT.ImageBaseURIFrozen("ipfs://bafynew/");
        nft.freezeImageBaseURI();
        assertTrue(nft.imageBaseURIFrozen());
        vm.expectRevert(AgentNFT.ImageBaseURIIsFrozen.selector);
        nft.setImageBaseURI("ipfs://bafyother/");
        vm.expectRevert(AgentNFT.ImageBaseURIIsFrozen.selector);
        nft.freezeImageBaseURI();
        vm.stopPrank();
        assertEq(nft.imageBaseURI(), "ipfs://bafynew/");
    }

    function test_ImageLinkThatWouldBreakJsonIsRejected() public {
        string[6] memory bad = ["", "ipfs://no-slash", 'ipfs://a"b/', "ipfs://a\\b/", "ipfs://a b/", "ipfs://a\nb/"];
        vm.startPrank(admin);
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(AgentNFT.InvalidImageBaseURI.selector);
            nft.setImageBaseURI(bad[i]);
        }
        vm.stopPrank();
    }

    // ----- helpers -----

    function _slice(string memory s, uint256 start, uint256 end) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(end - start);
        for (uint256 i = start; i < end; ++i) {
            out[i - start] = b[i];
        }
        return string(out);
    }

    function _base64Decode(string memory data) internal pure returns (bytes memory) {
        bytes memory input = bytes(data);
        bytes memory table = bytes("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
        uint8[128] memory rev;
        for (uint8 i = 0; i < 64; ++i) {
            rev[uint8(table[i])] = i;
        }
        uint256 pad = 0;
        if (input.length > 0 && input[input.length - 1] == "=") ++pad;
        if (input.length > 1 && input[input.length - 2] == "=") ++pad;
        bytes memory out = new bytes((input.length / 4) * 3 - pad);
        uint256 o = 0;
        for (uint256 i = 0; i < input.length; i += 4) {
            uint256 n = (uint256(rev[uint8(input[i])]) << 18) | (uint256(rev[uint8(input[i + 1])]) << 12)
                | (uint256(rev[uint8(input[i + 2])]) << 6) | uint256(rev[uint8(input[i + 3])]);
            if (o < out.length) out[o++] = bytes1(uint8(n >> 16));
            if (o < out.length) out[o++] = bytes1(uint8(n >> 8));
            if (o < out.length) out[o++] = bytes1(uint8(n));
        }
        return out;
    }

    function test_Base64HelperRoundTrips() public pure {
        bytes memory sample = bytes('{"a":"b"}x');
        assertEq(_base64Decode(Base64.encode(sample)), sample);
    }
}

contract AgentNFTRoyaltyTest is AgentNFTBase {
    function test_RoyaltyIsFivePercentToTreasury() public view {
        (address receiver, uint256 amount) = nft.royaltyInfo(1, 10_000 ether);
        assertEq(receiver, treasury);
        assertEq(amount, 500 ether);
    }

    function test_TreasuryChangeMovesRoyalties() public {
        address newTreasury = makeAddr("new treasury");
        vm.prank(admin);
        vm.expectEmit(address(nft));
        emit AgentNFT.TreasurySet(treasury, newTreasury);
        nft.setTreasury(newTreasury);
        (address receiver, uint256 amount) = nft.royaltyInfo(1, 1 ether);
        assertEq(receiver, newTreasury);
        assertEq(amount, 0.05 ether);
        assertEq(nft.treasury(), newTreasury);
    }

    function test_SupportsErc721MetadataRoyaltyAnd4906() public view {
        assertTrue(nft.supportsInterface(0x80ac58cd), "ERC-721");
        assertTrue(nft.supportsInterface(0x5b5e139f), "ERC-721 metadata");
        assertTrue(nft.supportsInterface(0x2a55205a), "ERC-2981");
        assertTrue(nft.supportsInterface(0x49064906), "ERC-4906");
        assertTrue(nft.supportsInterface(0x01ffc9a7), "ERC-165");
        assertFalse(nft.supportsInterface(0xffffffff));
    }
}

contract AgentNFTAdminTest is AgentNFTBase {
    using stdJson for string;

    function test_EveryAdminFunctionIsOwnerOnly() public {
        address stranger = freshWallet();
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.startPrank(stranger);
        vm.expectRevert(unauthorized);
        nft.setClaimRequired(false);
        vm.expectRevert(unauthorized);
        nft.setClaimSigner(stranger);
        vm.expectRevert(unauthorized);
        nft.setImageBaseURI("ipfs://x/");
        vm.expectRevert(unauthorized);
        nft.freezeImageBaseURI();
        vm.expectRevert(unauthorized);
        nft.setTreasury(stranger);
        vm.expectRevert(unauthorized);
        nft.setEscrow(address(escrow));
        vm.expectRevert(unauthorized);
        nft.renounceOwnership();
        vm.expectRevert(unauthorized);
        nft.transferOwnership(stranger);
        vm.stopPrank();
    }

    function test_AdminChangesEmitEvents() public {
        vm.startPrank(admin);
        vm.expectEmit(address(nft));
        emit AgentNFT.ClaimRequiredSet(false);
        nft.setClaimRequired(false);
        address newSigner = makeAddr("signer 2");
        vm.expectEmit(address(nft));
        emit AgentNFT.ClaimSignerSet(signer.addr, newSigner);
        nft.setClaimSigner(newSigner);
        vm.expectEmit(address(nft));
        emit AgentNFT.EscrowSet(address(escrow));
        nft.setEscrow(address(escrow));
        vm.stopPrank();
    }

    function test_EscrowCanBeSetOnlyOnceAndMustBeAContract() public {
        vm.startPrank(admin);
        vm.expectRevert(AgentNFT.ZeroAddress.selector);
        nft.setEscrow(address(0));
        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.EscrowNotContract.selector, eoa));
        nft.setEscrow(eoa);
        nft.setEscrow(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.EscrowAlreadySet.selector, address(escrow)));
        nft.setEscrow(address(registry));
        vm.stopPrank();
        assertEq(nft.escrow(), address(escrow));
    }

    function test_ZeroSignerAndTreasuryAreRejected() public {
        vm.startPrank(admin);
        vm.expectRevert(AgentNFT.ZeroAddress.selector);
        nft.setClaimSigner(address(0));
        vm.expectRevert(AgentNFT.ZeroAddress.selector);
        nft.setTreasury(address(0));
        vm.stopPrank();
    }

    function test_RenounceIsDisabledAndTwoStepTransferWorks() public {
        vm.prank(admin);
        vm.expectRevert(AgentNFT.RenounceDisabled.selector);
        nft.renounceOwnership();

        address next = makeAddr("next admin");
        vm.prank(admin);
        nft.transferOwnership(next);
        assertEq(nft.owner(), admin, "pending until accepted");
        vm.prank(next);
        nft.acceptOwnership();
        assertEq(nft.owner(), next);
    }

    /// Every admin power, used in every way, leaves supply, counts, tiers and
    /// species exactly as they were.
    function test_AdminCannotChangeSupplyCountsTiersOrSpecies() public {
        vm.prank(admin);
        nft.setClaimRequired(false);
        mintMany(40);
        revealBatch(keccak256("before admin"));
        mintMany(5);

        uint8[45] memory speciesBefore;
        for (uint256 id = 1; id <= 45; ++id) {
            speciesBefore[id - 1] = nft.speciesOf(id);
        }
        uint256[26] memory remainingBefore;
        for (uint8 s = 1; s <= 25; ++s) {
            remainingBefore[s] = nft.remainingOf(s);
        }

        vm.startPrank(admin);
        nft.setClaimRequired(true);
        nft.setClaimRequired(false);
        nft.setClaimSigner(makeAddr("s2"));
        nft.setImageBaseURI("ipfs://bafyx/");
        nft.freezeImageBaseURI();
        nft.setTreasury(makeAddr("t2"));
        nft.setEscrow(address(escrow));
        nft.transferOwnership(makeAddr("a2"));
        vm.stopPrank();

        assertEq(nft.MAX_SUPPLY(), 1000);
        assertEq(nft.totalMinted(), 45);
        assertEq(nft.remainingSupply(), 960);
        for (uint256 id = 1; id <= 45; ++id) {
            assertEq(nft.speciesOf(id), speciesBefore[id - 1]);
        }
        for (uint8 s = 1; s <= 25; ++s) {
            assertEq(nft.remainingOf(s), remainingBefore[s]);
        }
    }

    /// The compiled ABI has exactly these state-changing functions. Anything
    /// new (a mint for the admin, a supply or species setter) fails here.
    function test_StateChangingFunctionsAreExactlyTheIntendedSet() public view {
        string memory artifact = vm.readFile("./out/AgentNFT.sol/AgentNFT.json");
        string[] memory expected = new string[](19);
        expected[0] = "_entropyCallback";
        expected[1] = "acceptOwnership";
        expected[2] = "approve";
        expected[3] = "freezeImageBaseURI";
        expected[4] = "mint";
        expected[5] = "mintWithClaim";
        expected[6] = "reveal";
        expected[7] = "requestReveal";
        expected[8] = "safeTransferFrom";
        expected[9] = "safeTransferFrom";
        expected[10] = "setApprovalForAll";
        expected[11] = "setClaimRequired";
        expected[12] = "setClaimSigner";
        expected[13] = "setEscrow";
        expected[14] = "setImageBaseURI";
        expected[15] = "setTreasury";
        expected[16] = "transferFrom";
        expected[17] = "transferOwnership";
        expected[18] = "renounceOwnership";

        uint256 found;
        for (uint256 i = 0; i < 200; ++i) {
            string memory path = string.concat(".abi[", vm.toString(i), "]");
            if (!vm.keyExistsJson(artifact, path)) break;
            if (keccak256(bytes(artifact.readString(string.concat(path, ".type")))) != keccak256("function")) {
                continue;
            }
            string memory mutability = artifact.readString(string.concat(path, ".stateMutability"));
            bool changesState = keccak256(bytes(mutability)) == keccak256("nonpayable")
                || keccak256(bytes(mutability)) == keccak256("payable");
            if (!changesState) continue;
            string memory name = artifact.readString(string.concat(path, ".name"));
            bool allowed;
            for (uint256 j = 0; j < expected.length; ++j) {
                if (keccak256(bytes(name)) == keccak256(bytes(expected[j]))) allowed = true;
            }
            assertTrue(allowed, string.concat("unexpected state-changing function: ", name));
            ++found;
        }
        // renounceOwnership is view (it always reverts), so 18 remain.
        assertEq(found, 18, "state-changing function count");
    }
}
