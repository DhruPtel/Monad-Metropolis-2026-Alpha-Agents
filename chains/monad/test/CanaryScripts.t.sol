// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {CanaryAgent} from "../script/CanaryAgent.sol";
import {DeployAccountFactory} from "../script/DeployAccountFactory.s.sol";
import {DeployCanaryAgent} from "../script/DeployCanaryAgent.s.sol";

/// P2-EC part 2's CanaryAgent (D-250) and the canary's salt scope, without a fork.
contract CanaryScriptsTest is Test {
    address internal owner = makeAddr("canary owner");

    function test_CanaryAgentRefusesEveryChainButMainnet() public {
        uint256[3] memory others = [uint256(143143), 10143, 1];
        for (uint256 k = 0; k < others.length; k++) {
            vm.chainId(others[k]);
            vm.expectRevert(abi.encodeWithSelector(CanaryAgent.WrongChain.selector, others[k]));
            new CanaryAgent(owner);
        }
        vm.chainId(143);
        vm.expectRevert(CanaryAgent.ZeroOwner.selector);
        new CanaryAgent(address(0));
    }

    function test_CanaryAgentKnowsOneAgentOwnedByItsOwnerAtEpochZero() public {
        vm.chainId(143);
        CanaryAgent agent = new CanaryAgent(owner);
        assertEq(agent.ownerOf(1), owner);
        assertEq(agent.ownerEpoch(1), 0);
        assertEq(agent.owner(), owner);
        for (uint256 id = 0; id < 4; id++) {
            if (id == 1) continue;
            vm.expectRevert(abi.encodeWithSelector(CanaryAgent.UnknownAgent.selector, id));
            agent.ownerOf(id);
            vm.expectRevert(abi.encodeWithSelector(CanaryAgent.UnknownAgent.selector, id));
            agent.ownerEpoch(id);
        }
    }

    function test_CanaryAgentHasNoTransferMintApprovalOrErc721Surface() public {
        vm.chainId(143);
        address agent = address(new CanaryAgent(owner));
        bytes4[7] memory absent = [
            bytes4(keccak256("transferFrom(address,address,uint256)")),
            bytes4(keccak256("safeTransferFrom(address,address,uint256)")),
            bytes4(keccak256("approve(address,uint256)")),
            bytes4(keccak256("setApprovalForAll(address,bool)")),
            bytes4(keccak256("supportsInterface(bytes4)")),
            bytes4(keccak256("balanceOf(address)")),
            bytes4(keccak256("mint(address)"))
        ];
        for (uint256 k = 0; k < absent.length; k++) {
            (bool ok,) = agent.call(abi.encodeWithSelector(absent[k], address(this), address(this), uint256(1)));
            assertFalse(ok, "no such function");
        }
    }

    function test_MainnetDeploysOnlyWithTheCanaryScopeAndGate() public {
        DeployAccountFactory custody = new DeployAccountFactory();
        vm.chainId(143);
        vm.setEnv("DEPLOY_SALT_SCOPE", "");
        vm.setEnv("CANARY_SIGNING_ENABLED", "true");
        vm.expectRevert(
            bytes("Monad mainnet deployments here are the P2-EC canary's: DEPLOY_SALT_SCOPE=p2ec.canary (D-249)")
        );
        custody.salt("executor");

        vm.setEnv("DEPLOY_SALT_SCOPE", "p2ec.canary");
        vm.setEnv("CANARY_SIGNING_ENABLED", "false");
        vm.expectRevert(bytes("the canary deploys to Monad mainnet only with CANARY_SIGNING_ENABLED=true (D-251)"));
        custody.salt("executor");

        vm.setEnv("CANARY_SIGNING_ENABLED", "true");
        assertEq(custody.salt("executor"), keccak256("alpha-agents.p2ec.canary.executor.v1"));
        assertEq(new DeployCanaryAgent().salt("canary-agent"), keccak256("alpha-agents.p2ec.canary.canary-agent.v1"));

        // The canary scope is refused off mainnet.
        vm.chainId(10143);
        vm.expectRevert(bytes("Monad testnet deployments use DEPLOY_SALT_SCOPE=p2ec.testnet (D-249)"));
        custody.salt("executor");
        vm.chainId(143143);
        vm.expectRevert(bytes("the local fork uses the v1 salts; unset DEPLOY_SALT_SCOPE"));
        custody.salt("executor");
        vm.setEnv("DEPLOY_SALT_SCOPE", "");
        vm.setEnv("CANARY_SIGNING_ENABLED", "false");
    }

    function test_DeployCanaryAgentRefusesAnyChainButMainnet() public {
        DeployCanaryAgent script = new DeployCanaryAgent();
        vm.chainId(10143);
        vm.expectRevert(bytes("CanaryAgent is for Monad mainnet (143) only"));
        script.run();
    }
}
