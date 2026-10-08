// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console} from "forge-std/Script.sol";
import {CanaryAgent} from "./CanaryAgent.sol";
import {DeployScope} from "./DeployScope.sol";

/// Deploys CanaryAgent (D-250) through the deterministic CREATE2 factory with
/// the `p2ec.canary` salt, on Monad mainnet only, or finds it. Run it through
/// `pnpm deploy:canary`, which sets CANARY_AGENT_OWNER (the canary owner,
/// D-259), DEPLOYER_PRIVATE_KEY, DEPLOY_SALT_SCOPE=p2ec.canary and
/// CANARY_SIGNING_ENABLED=true.
contract DeployCanaryAgent is DeployScope {
    string public constant SALT_NAME = "canary-agent";

    function run() external returns (CanaryAgent agent) {
        require(block.chainid == MONAD_MAINNET_CHAIN_ID, "CanaryAgent is for Monad mainnet (143) only");
        bytes32 agentSalt = salt(SALT_NAME);
        address owner = vm.envAddress("CANARY_AGENT_OWNER");
        bytes memory initCode = abi.encodePacked(type(CanaryAgent).creationCode, abi.encode(owner));
        address predicted = vm.computeCreate2Address(agentSalt, keccak256(initCode), CREATE2_FACTORY);
        if (predicted.code.length == 0) {
            _startBroadcast();
            agent = new CanaryAgent{salt: agentSalt}(owner);
            vm.stopBroadcast();
            require(address(agent) == predicted, "deployed address differs from prediction");
        } else {
            console.log("CanaryAgent already deployed");
            agent = CanaryAgent(predicted);
        }
        require(agent.owner() == owner, "canary owner");
        require(agent.ownerOf(1) == owner && agent.ownerEpoch(1) == 0, "agent 1");
        console.log("CANARY_AGENT_ADDRESS", address(agent));
        console.log("CANARY_AGENT_CODE_SIZE", address(agent).code.length);
    }
}
