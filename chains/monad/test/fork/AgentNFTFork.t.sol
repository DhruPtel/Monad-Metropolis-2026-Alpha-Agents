// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, console} from "forge-std/Test.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AgentNFT} from "../../src/AgentNFT.sol";
import {IERC6551Registry, ITokenboundAccount, IEntropyV2} from "../../src/interfaces/IExternal.sol";
import {MockEscrow} from "../mocks/AgentNFTMocks.sol";

interface ITokenboundV3 {
    function owner() external view returns (address);
    function state() external view returns (uint256);
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory);
}

interface IAccountGuardian {
    function owner() external view returns (address);
    function isTrustedImplementation(address implementation) external view returns (bool);
}

interface IEntropyReads {
    struct ProviderInfo {
        uint128 feeInWei;
        uint128 accruedFeesInWei;
        bytes32 originalCommitment;
        uint64 originalCommitmentSequenceNumber;
        bytes commitmentMetadata;
        bytes uri;
        uint64 endSequenceNumber;
        uint64 sequenceNumber;
        bytes32 currentCommitment;
        uint64 currentCommitmentSequenceNumber;
        address feeManager;
        uint32 maxNumHashes;
        uint32 defaultGasLimit;
    }

    struct Request {
        address provider;
        uint64 sequenceNumber;
        uint32 numHashes;
        bytes32 commitment;
        uint64 blockNumber;
        address requester;
        bool useBlockhash;
        uint8 callbackStatus;
        uint16 gasLimit10k;
    }

    function getDefaultProvider() external view returns (address);
    function getProviderInfoV2(address provider) external view returns (ProviderInfo memory);
    function getRequestV2(address provider, uint64 sequenceNumber) external view returns (Request memory);
}

contract SkillToken is ERC1155 {
    constructor() ERC1155("") {}

    function mint(address to, uint256 id) external {
        _mint(to, id, 1, "");
    }
}

/// AgentNFT against the real canonical ERC-6551 registry, Tokenbound v3 and
/// Pyth Entropy on the local fork of Monad mainnet (pnpm test:fork).
/// Covers spikes TB-1, TB-2, TB-3, TB-5, TB-8, TB-9b and TB-9c.
contract AgentNFTForkTest is Test {
    address internal constant REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address internal constant ACCOUNT_PROXY = 0x55266d75D1a14E4572138116aF39863Ed6596E7F;
    address internal constant ACCOUNT_IMPLEMENTATION = 0x41C8f39463A868d3A88af00cd0fe7102F30E44eC;
    address internal constant ACCOUNT_GUARDIAN = 0x2FE5ccb0d7Ea195FEb87987d3573F9fcCE2b5D57;
    address internal constant TOKENBOUND_SAFE = 0x781b6A527482828bB04F33563797d4b696ddF328;
    address internal constant ENTROPY = 0xD458261E832415CFd3BAE5E416FdF3230ce6F134;
    address internal constant ENTROPY_DEFAULT_PROVIDER = 0x52DeaA1c84233F7bb8C8A45baeDE41091c616506;
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    string internal constant LOCAL_FORK_URL = "http://127.0.0.1:8545";

    AgentNFT internal nft;
    MockEscrow internal escrow;
    address internal admin = makeAddr("fork admin");
    address internal alice = makeAddr("fork alice");
    address internal bob = makeAddr("fork bob");

    function setUp() public {
        if (bytes(vm.envOr("MONAD_RPC_URL", string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("LOCAL_FORK_URL", LOCAL_FORK_URL));
        nft = new AgentNFT(
            admin,
            makeAddr("fork signer"),
            makeAddr("fork treasury"),
            "ipfs://bafyfork/",
            IERC6551Registry(REGISTRY),
            ACCOUNT_PROXY,
            ACCOUNT_IMPLEMENTATION,
            IEntropyV2(ENTROPY)
        );
        escrow = new MockEscrow();
        vm.startPrank(admin);
        nft.setClaimRequired(false);
        nft.setEscrow(address(escrow));
        vm.stopPrank();
    }

    function _mint(address who) internal returns (uint256 id) {
        vm.prank(who);
        id = nft.mint();
    }

    /// TB-1: mint creates the account at the registry's address, initialized
    /// to AccountV3Upgradable, owned by the minter, bound to the agent.
    function test_MintCreatesCanonicalAccount() public {
        address predicted =
            IERC6551Registry(REGISTRY).account(ACCOUNT_PROXY, bytes32(0), block.chainid, address(nft), 1);
        assertEq(predicted.code.length, 0, "not deployed before mint");
        uint256 id = _mint(alice);
        address tba = nft.tbaOf(id);
        assertEq(tba, predicted, "registry address");
        assertEq(tba.code.length, 0xAD, "ERC-1167 clone with footer");
        assertEq(
            address(uint160(uint256(ITokenboundAccount(tba).extsload(IMPLEMENTATION_SLOT)))),
            ACCOUNT_IMPLEMENTATION,
            "implementation slot (TB-9b: readable by a contract)"
        );
        assertEq(ITokenboundV3(tba).owner(), alice);
        (uint256 chainId, address tokenContract, uint256 tokenId) = ITokenboundAccount(tba).token();
        assertEq(chainId, block.chainid, "bound to the fork's chain (143143)");
        assertEq(tokenContract, address(nft));
        assertEq(tokenId, 1);
    }

    /// A front-runner who creates and initializes the account first cannot
    /// block the mint.
    function test_FrontRunAccountCreationDoesNotBlockMint() public {
        address tba =
            IERC6551Registry(REGISTRY).createAccount(ACCOUNT_PROXY, bytes32(0), block.chainid, address(nft), 1);
        ITokenboundAccount(tba).initialize(ACCOUNT_IMPLEMENTATION);
        vm.expectRevert();
        ITokenboundAccount(tba).initialize(ACCOUNT_IMPLEMENTATION);
        assertEq(_mint(alice), 1);
        assertEq(nft.tbaOf(1), tba);
        assertEq(ITokenboundV3(tba).owner(), alice);
    }

    /// TB-2 and TB-3: a skill moves in without changing state; only the owner
    /// can move it out.
    function test_SkillInAndOwnerOnlyExecute() public {
        uint256 id = _mint(alice);
        address tba = nft.tbaOf(id);
        SkillToken skill = new SkillToken();
        uint256 stateBefore = ITokenboundV3(tba).state();
        skill.mint(tba, 7);
        assertEq(skill.balanceOf(tba, 7), 1);
        assertEq(ITokenboundV3(tba).state(), stateBefore, "incoming tokens do not change state");

        bytes memory out = abi.encodeCall(skill.safeTransferFrom, (tba, alice, 7, 1, ""));
        vm.prank(bob);
        vm.expectRevert();
        ITokenboundV3(tba).execute(address(skill), 0, out, 0);

        vm.prank(alice);
        ITokenboundV3(tba).execute(address(skill), 0, out, 0);
        assertEq(skill.balanceOf(alice, 7), 1);
    }

    /// TB-5: after an escrow transfer, control moves to the new owner in the
    /// same block, and the epoch bumps.
    function test_TransferMovesControlAndBumpsEpoch() public {
        uint256 id = _mint(alice);
        address tba = nft.tbaOf(id);
        vm.prank(alice);
        nft.approve(address(escrow), id);
        escrow.move(nft, alice, bob, id);

        assertEq(ITokenboundV3(tba).owner(), bob);
        assertEq(nft.ownerEpoch(id), 1);
        vm.prank(alice);
        vm.expectRevert();
        ITokenboundV3(tba).execute(alice, 0, "", 0);
        vm.prank(bob);
        ITokenboundV3(tba).execute(bob, 0, "", 0);
    }

    /// TB-8: an agent can never be moved into an agent account.
    function test_CannotTransferIntoAgentAccount() public {
        uint256 a = _mint(alice);
        uint256 b = _mint(bob);
        vm.prank(alice);
        nft.approve(address(escrow), a);
        address bobTba = nft.tbaOf(b);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.TransferToAgentAccount.selector, bobTba));
        escrow.move(nft, alice, bobTba, a);
        address ownTba = nft.tbaOf(a);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.TransferToAgentAccount.selector, ownTba));
        escrow.move(nft, alice, ownTba, a);
    }

    /// TB-9c: the guardian is owned by the Tokenbound Safe and trusts neither
    /// the implementation nor the proxy, so no account can be upgraded.
    function test_GuardianStateIsAtDefaults() public view {
        assertEq(IAccountGuardian(ACCOUNT_GUARDIAN).owner(), TOKENBOUND_SAFE);
        assertFalse(IAccountGuardian(ACCOUNT_GUARDIAN).isTrustedImplementation(ACCOUNT_IMPLEMENTATION));
        assertFalse(IAccountGuardian(ACCOUNT_GUARDIAN).isTrustedImplementation(ACCOUNT_PROXY));
    }

    /// The reveal against real Entropy: the request is recorded for AgentNFT
    /// with the default provider, and the callback fits the provider's
    /// default gas limit. Delivery is impersonated, since the provider's
    /// keeper does not serve the fork.
    function test_RevealThroughRealEntropy() public {
        for (uint256 i = 0; i < 5; ++i) {
            _mint(makeAddr(string.concat("fork minter ", vm.toString(i))));
        }
        assertEq(IEntropyReads(ENTROPY).getDefaultProvider(), ENTROPY_DEFAULT_PROVIDER);
        uint256 fee = IEntropyV2(ENTROPY).getFeeV2();
        vm.deal(address(this), fee + 1 ether);
        uint64 sequence = nft.requestReveal{value: fee + 1 ether}();
        assertEq(address(this).balance, 1 ether, "excess refunded");

        IEntropyReads.Request memory req = IEntropyReads(ENTROPY).getRequestV2(ENTROPY_DEFAULT_PROVIDER, sequence);
        assertEq(req.requester, address(nft));
        assertEq(req.sequenceNumber, sequence);

        IEntropyReads.ProviderInfo memory info = IEntropyReads(ENTROPY).getProviderInfoV2(ENTROPY_DEFAULT_PROVIDER);
        vm.prank(ENTROPY);
        uint256 gasBefore = gasleft();
        nft._entropyCallback(sequence, ENTROPY_DEFAULT_PROVIDER, keccak256("fork randomness"));
        uint256 callbackGas = gasBefore - gasleft();
        console.log("callback gas", callbackGas, "provider default gas limit", info.defaultGasLimit);
        assertLt(callbackGas, info.defaultGasLimit, "callback fits the default gas limit");

        assertEq(nft.reveal(type(uint256).max), 5);
        for (uint256 id = 1; id <= 5; ++id) {
            assertTrue(nft.isRevealed(id));
        }
    }

    function test_GasForMintAndReveal() public {
        address minter = makeAddr("gas minter");
        vm.prank(minter);
        uint256 g = gasleft();
        nft.mint();
        console.log("mint gas (fork, real registry and account)", g - gasleft());

        for (uint256 i = 0; i < 49; ++i) {
            _mint(makeAddr(string.concat("gas minter ", vm.toString(i))));
        }
        uint256 fee = IEntropyV2(ENTROPY).getFeeV2();
        vm.deal(address(this), fee);
        g = gasleft();
        uint64 sequence = nft.requestReveal{value: fee}();
        console.log("requestReveal gas", g - gasleft());
        vm.prank(ENTROPY);
        nft._entropyCallback(sequence, ENTROPY_DEFAULT_PROVIDER, keccak256("gas"));
        g = gasleft();
        nft.reveal(1);
        console.log("reveal gas, 1 agent", g - gasleft());
        g = gasleft();
        nft.reveal(49);
        console.log("reveal gas, 49 agents", g - gasleft());
    }

    receive() external payable {}
}
