// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IAttestationVerifier} from "../interfaces/IFund.sol";

/// The class A price attestation verifier (F-U12, D-337): checks that an
/// attestation was signed by the platform's attestor key as EIP-712 data for
/// this chain and this verifier, that it names a token and a positive price,
/// and that it is valid for at most MAX_LIFE seconds, then returns the token,
/// the price and when it stops being valid. The oracle adapter refuses one
/// past its `validUntil`; the registry sets this contract through its
/// timelock like a feed (SET_VERIFIER), and a new attestor key is a new
/// verifier. The attestor key signs prices and nothing else: nothing here
/// moves funds, and the custody core's caps hold whatever the price says.
contract AttestationVerifier is IAttestationVerifier, EIP712 {
    /// The longest an attestation may be valid for: a sandwich cannot outlast the reference (A-62).
    uint64 public constant MAX_LIFE = 60;

    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(uint256 chainId,address token,uint256 priceE18,uint64 observedAt,uint64 validUntil)");

    /// The one key whose attestations count.
    address public immutable ATTESTOR;

    error ZeroAttestor();
    error BadSigner(address recovered);
    error BadToken();
    error BadPrice();
    error BadLife(uint64 observedAt, uint64 validUntil);
    error WrongChain(uint256 chainId);

    constructor(address attestor_) EIP712("AlphaAgentsAttestor", "1") {
        if (attestor_ == address(0)) revert ZeroAttestor();
        ATTESTOR = attestor_;
    }

    /// The attestation's bytes: `abi.encode(token, priceE18, observedAt, validUntil, signature)`.
    function verify(bytes calldata attestation)
        external
        view
        returns (address token, uint256 priceE18, uint64 validUntil)
    {
        uint64 observedAt;
        bytes memory signature;
        (token, priceE18, observedAt, validUntil, signature) =
            abi.decode(attestation, (address, uint256, uint64, uint64, bytes));
        if (token == address(0)) revert BadToken();
        if (priceE18 == 0) revert BadPrice();
        if (validUntil < observedAt || validUntil - observedAt > MAX_LIFE) revert BadLife(observedAt, validUntil);
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(ATTESTATION_TYPEHASH, block.chainid, token, priceE18, observedAt, validUntil))
        );
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != ATTESTOR) revert BadSigner(recovered);
    }

    /// The digest an attestor signs for these values on this chain and verifier, for the service and tests.
    function digestOf(address token, uint256 priceE18, uint64 observedAt, uint64 validUntil)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(ATTESTATION_TYPEHASH, block.chainid, token, priceE18, observedAt, validUntil))
        );
    }

    /// The EIP-712 domain separator, for the service's own check.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
