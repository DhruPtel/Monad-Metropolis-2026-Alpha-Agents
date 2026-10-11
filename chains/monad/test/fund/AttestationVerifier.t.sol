// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {AttestationVerifier} from "../../src/fund/AttestationVerifier.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {FeedConfig, FeedLeg, ITokenRegistry, Lane, PriceClass} from "../../src/interfaces/IFund.sol";
import {MockToken} from "../mocks/CustodyMocks.sol";
import {FundBase} from "./FundBase.sol";

/// The attestation verifier (F-U12): a valid attestation from the attestor
/// key verifies; a wrong signer, a tampered price, a zero token or price, or
/// a life over 60 seconds is refused; set in the registry through the
/// timelock, the oracle prices a class A token from it and refuses one that
/// expired; and a vault never buys a screened class A token however the
/// verifier is set (D-338, D-355).
contract AttestationVerifierTest is FundBase {
    uint256 internal constant ATTESTOR_KEY = 0xA11CE;
    address internal attestorAddr;
    AttestationVerifier internal verifier;
    MockToken internal meme;

    function setUp() public override {
        super.setUp();
        attestorAddr = vm.addr(ATTESTOR_KEY);
        verifier = new AttestationVerifier(attestorAddr);
        meme = new MockToken("MEME", 18);
        vm.prank(SCREENER);
        tokens.addScreened(address(meme), 1_500, keccak256("screen"), uint64(block.timestamp));
    }

    function _sign(uint256 key, address token, uint256 price, uint64 observedAt, uint64 validUntil)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = verifier.digestOf(token, price, observedAt, validUntil);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encode(token, price, observedAt, validUntil, abi.encodePacked(r, s, v));
    }

    function test_verifiesTheAttestorsSignature() public view {
        uint64 now_ = uint64(block.timestamp);
        bytes memory a = _sign(ATTESTOR_KEY, address(meme), 2e18, now_, now_ + 60);
        (address token, uint256 price, uint64 validUntil) = verifier.verify(a);
        assertEq(token, address(meme));
        assertEq(price, 2e18);
        assertEq(validUntil, now_ + 60);
        assertEq(verifier.ATTESTOR(), attestorAddr);
        assertEq(verifier.MAX_LIFE(), 60);
    }

    function test_refusesAnotherSigner() public {
        uint64 now_ = uint64(block.timestamp);
        bytes memory a = _sign(0xB0B, address(meme), 2e18, now_, now_ + 60);
        vm.expectRevert(abi.encodeWithSelector(AttestationVerifier.BadSigner.selector, vm.addr(0xB0B)));
        verifier.verify(a);
    }

    function test_refusesATamperedPrice() public {
        uint64 now_ = uint64(block.timestamp);
        bytes memory signed = _sign(ATTESTOR_KEY, address(meme), 2e18, now_, now_ + 60);
        (address token,, uint64 observedAt, uint64 validUntil, bytes memory sig) =
            abi.decode(signed, (address, uint256, uint64, uint64, bytes));
        bytes memory tampered = abi.encode(token, uint256(4e18), observedAt, validUntil, sig);
        vm.expectPartialRevert(AttestationVerifier.BadSigner.selector);
        verifier.verify(tampered);
    }

    function test_refusesTooLongALifeAndBadValues() public {
        uint64 now_ = uint64(block.timestamp);
        bytes memory tooLong = _sign(ATTESTOR_KEY, address(meme), 2e18, now_, now_ + 61);
        vm.expectRevert(abi.encodeWithSelector(AttestationVerifier.BadLife.selector, now_, now_ + 61));
        verifier.verify(tooLong);
        bytes memory backwards = _sign(ATTESTOR_KEY, address(meme), 2e18, now_ + 10, now_);
        vm.expectRevert(abi.encodeWithSelector(AttestationVerifier.BadLife.selector, now_ + 10, now_));
        verifier.verify(backwards);
        bytes memory zeroPrice = _sign(ATTESTOR_KEY, address(meme), 0, now_, now_ + 60);
        vm.expectRevert(AttestationVerifier.BadPrice.selector);
        verifier.verify(zeroPrice);
        bytes memory zeroToken = _sign(ATTESTOR_KEY, address(0), 2e18, now_, now_ + 60);
        vm.expectRevert(AttestationVerifier.BadToken.selector);
        verifier.verify(zeroToken);
        vm.expectRevert(AttestationVerifier.ZeroAttestor.selector);
        new AttestationVerifier(address(0));
    }

    function test_setInTheRegistryThroughTheTimelockTheOraclePricesClassAFromIt() public {
        bytes memory data = abi.encode(address(verifier));
        uint8 action = tokens.SET_VERIFIER();
        uint256 delay = tokens.RISK_TIMELOCK();
        vm.prank(ADMIN);
        tokens.propose(action, data);
        // Not before the timelock.
        vm.expectPartialRevert(bytes4(keccak256("TooEarly(uint64)")));
        tokens.execute(action, data);
        vm.warp(block.timestamp + delay + 1);
        tokens.execute(action, data);
        assertEq(tokens.verifier(), address(verifier));

        uint64 now_ = uint64(block.timestamp);
        bytes memory fresh = _sign(ATTESTOR_KEY, address(meme), 3e18, now_, now_ + 60);
        assertEq(oracle.attestedPriceE18(address(meme), fresh), 3e18);
        // Expired by the oracle's own clock.
        vm.warp(block.timestamp + 61);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapterV3.BadAttestation.selector, address(meme)));
        oracle.attestedPriceE18(address(meme), fresh);
        // Another token's attestation does not price this one.
        uint64 later = uint64(block.timestamp);
        bytes memory other = _sign(ATTESTOR_KEY, address(tokA), 3e18, later, later + 60);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapterV3.BadAttestation.selector, address(meme)));
        oracle.attestedPriceE18(address(meme), other);
    }

    function test_aVaultNeverBuysAScreenedClassATokenWhateverTheVerifier() public {
        bytes memory data = abi.encode(address(verifier));
        uint8 action = tokens.SET_VERIFIER();
        uint256 delay = tokens.RISK_TIMELOCK();
        vm.prank(ADMIN);
        tokens.propose(action, data);
        vm.warp(block.timestamp + delay + 1);
        tokens.execute(action, data);
        assertFalse(tokens.buyableFor(address(meme), address(vault)), "a vault never holds screened tokens (D-355)");
        assertTrue(tokens.buyableFor(address(meme), address(optedIn)), "an opted-in personal account may");
        assertFalse(tokens.buyableFor(address(meme), address(notOptedIn)), "an account that did not opt in may not");
    }
}
