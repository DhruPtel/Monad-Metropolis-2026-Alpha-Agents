// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console} from "forge-std/Script.sol";
import {AttestationVerifier} from "../src/fund/AttestationVerifier.sol";
import {DeployFund} from "./DeployFund.s.sol";

/// Deploys the class A attestation verifier (F-U12) for the attestor key
/// ATTESTOR_ADDRESS names, at its CREATE2 address (the `fund-attestation-verifier`
/// salt, version 1), or finds it. Setting it in the TokenRegistry is the
/// registry's own timelocked change (SET_VERIFIER, 9 days), which
/// scripts/lib/attestor.js drives on the local fork by proposing as the admin,
/// moving the fork's clock, and executing; on a real chain the admin proposes
/// and anyone executes after the delay.
contract DeployAttestor is DeployFund {
    function run() external override {
        address attestor = vm.envAddress("ATTESTOR_ADDRESS");
        require(attestor != address(0), "ATTESTOR_ADDRESS is zero");
        bytes memory args = abi.encode(attestor);
        address verifier = _create2(
            salt("fund-attestation-verifier", SALT_VERSION),
            abi.encodePacked(type(AttestationVerifier).creationCode, args)
        );
        require(AttestationVerifier(verifier).ATTESTOR() == attestor, "verifier has another attestor");
        console.log("ATTESTATION_VERIFIER_ADDRESS", verifier);
        console.log("ATTESTATION_VERIFIER_CODE_SIZE", verifier.code.length);
        console.log("ATTESTOR_ADDRESS", attestor);
    }
}
