// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PoolKey} from "../src/interfaces/IUniswap.sol";
import {DeployAgentNFT} from "../script/DeployAgentNFT.s.sol";
import {DeployAccountFactory} from "../script/DeployAccountFactory.s.sol";
import {IPoolManagerLiquidity, PoolSeeder} from "../script/PoolSeeder.sol";
import {TestnetFeed} from "../script/TestnetFeed.sol";

/// P2-EC's testnet script contracts and the salt scope, without a fork.
contract TestnetScriptsTest is Test {
    address internal writer = makeAddr("writer");

    function test_TestnetFeedRefusesEveryChainButTestnet() public {
        vm.chainId(143);
        vm.expectRevert(abi.encodeWithSelector(TestnetFeed.WrongChain.selector, 143));
        new TestnetFeed(8, writer, "MON / USD", 1e8);
        vm.chainId(143143);
        vm.expectRevert(abi.encodeWithSelector(TestnetFeed.WrongChain.selector, 143143));
        new TestnetFeed(8, writer, "MON / USD", 1e8);
    }

    function test_TestnetFeedIsWrittenOnlyByItsWriterAndRedatesKeepTheAnswer() public {
        vm.chainId(10143);
        vm.warp(1_000);
        TestnetFeed feed = new TestnetFeed(8, writer, "MON / USD", 1e8);
        (uint80 round, int256 answer, uint256 started, uint256 updated, uint80 answeredIn) = feed.latestRoundData();
        assertEq(round, 1);
        assertEq(answer, 1e8);
        assertEq(started, 1_000);
        assertEq(updated, 1_000);
        assertEq(answeredIn, 1);
        assertEq(feed.decimals(), 8);

        vm.expectRevert(abi.encodeWithSelector(TestnetFeed.NotWriter.selector, address(this)));
        feed.redate();
        vm.expectRevert(abi.encodeWithSelector(TestnetFeed.NotWriter.selector, address(this)));
        feed.setAnswer(2e8);

        vm.warp(1_300);
        vm.prank(writer);
        feed.redate();
        (round, answer,, updated,) = feed.latestRoundData();
        assertEq(round, 2);
        assertEq(answer, 1e8, "redate keeps the answer");
        assertEq(updated, 1_300);

        vm.startPrank(writer);
        vm.expectRevert(abi.encodeWithSelector(TestnetFeed.BadAnswer.selector, int256(0)));
        feed.setAnswer(0);
        feed.setAnswer(0.99e8);
        vm.stopPrank();
        assertEq(feed.latestAnswer(), 0.99e8);
    }

    function test_PoolSeederIsTestnetOnlyAndOwnerOnly() public {
        vm.chainId(143);
        vm.expectRevert(abi.encodeWithSelector(PoolSeeder.WrongChain.selector, 143));
        new PoolSeeder(IPoolManagerLiquidity(address(1)), address(this));

        vm.chainId(10143);
        address owner = makeAddr("owner");
        PoolSeeder seeder = new PoolSeeder(IPoolManagerLiquidity(address(1)), owner);
        PoolKey memory key = PoolKey(address(0), address(2), 500, 10, address(0));
        vm.expectRevert(abi.encodeWithSelector(PoolSeeder.NotOwner.selector, address(this)));
        seeder.initialize(key, 1);
        vm.expectRevert(abi.encodeWithSelector(PoolSeeder.NotOwner.selector, address(this)));
        seeder.addLiquidity(key, -10, 10, 1);
        vm.expectRevert(abi.encodeWithSelector(PoolSeeder.NotOwner.selector, address(this)));
        seeder.removeLiquidity(key, -10, 10, 1);
        vm.expectRevert(abi.encodeWithSelector(PoolSeeder.NotPoolManager.selector, address(this)));
        seeder.unlockCallback("");

        vm.deal(address(this), 1 ether);
        (bool ok,) = address(seeder).call{value: 1}("");
        assertFalse(ok, "native MON only from the owner or PoolManager");
    }

    /// The local fork keeps the plan's v1 salts, so every local address is unchanged.
    function test_TheForkKeepsTheV1Salts() public {
        vm.chainId(143143);
        vm.setEnv("DEPLOY_SALT_SCOPE", "");
        DeployAgentNFT nftScript = new DeployAgentNFT();
        DeployAccountFactory custody = new DeployAccountFactory();
        assertEq(nftScript.salt("agent-nft"), keccak256("alpha-agents.agent-nft.v1"));
        assertEq(custody.salt("account-factory"), keccak256("alpha-agents.account-factory.v1"));
        assertEq(custody.salt("oracle-adapter"), keccak256("alpha-agents.oracle-adapter.v1"));
        assertEq(custody.salt("executor"), keccak256("alpha-agents.executor.v1"));
        assertEq(
            custody.salt("venue.uniswap-v4-mon-usdc-500"), keccak256("alpha-agents.venue.uniswap-v4-mon-usdc-500.v1")
        );
        assertEq(
            custody.salt("venue.uniswap-v3-usdc-wmon-3000"),
            keccak256("alpha-agents.venue.uniswap-v3-usdc-wmon-3000.v1")
        );
        assertEq(custody.salt("protocol-registry"), keccak256("alpha-agents.protocol-registry.v1"));

        vm.setEnv("DEPLOY_SALT_SCOPE", "p2ec.testnet");
        vm.expectRevert(bytes("the local fork uses the v1 salts; unset DEPLOY_SALT_SCOPE"));
        custody.salt("executor");

        vm.chainId(10143);
        assertEq(custody.salt("executor"), keccak256("alpha-agents.p2ec.testnet.executor.v1"));
        vm.chainId(143);
        vm.expectRevert(
            bytes("Monad mainnet deployments here are the P2-EC canary's: DEPLOY_SALT_SCOPE=p2ec.canary (D-249)")
        );
        custody.salt("executor");
        vm.chainId(1);
        vm.expectRevert(bytes("not the local fork (143143), Monad testnet (10143) or the mainnet canary (143)"));
        custody.salt("executor");
        vm.setEnv("DEPLOY_SALT_SCOPE", "");
    }
}
