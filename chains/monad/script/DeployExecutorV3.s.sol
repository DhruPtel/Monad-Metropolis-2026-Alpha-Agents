// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console} from "forge-std/Script.sol";
import {ExecutorV3} from "../src/fund/ExecutorV3.sol";
import {OracleAdapterV3} from "../src/fund/OracleAdapterV3.sol";
import {ProtocolRegistryV3} from "../src/fund/ProtocolRegistryV3.sol";
import {RouteAdapter} from "../src/fund/RouteAdapter.sol";
import {TokenRegistry} from "../src/fund/TokenRegistry.sol";
import {IAgentNFTView} from "../src/interfaces/ICustody.sol";
import {PolicyV3} from "../src/interfaces/IExecutorV3.sol";
import {ITokenRegistry, Lane} from "../src/interfaces/IFund.sol";
import {DeployFund} from "./DeployFund.s.sol";
import {ExecutorSetDeployer} from "./ExecutorSetDeployer.sol";

/// Deploys Executor v3 and the set it trades through (F-U4, D-361, D-363),
/// beside the F-U2 and F-U3 sets: the Executor with the launch policy; its
/// RouteAdapter and a ProtocolRegistryV3 that lists the adapter from its
/// construction, both from an ExecutorSetDeployer so no timelock stands between
/// deployment and the first trade; and an OracleAdapterV3 over that registry.
/// The TokenRegistry is the existing one. Run by `pnpm deploy:executor-v3`
/// (scripts/lib/executor-v3.js), which then deploys AccountFactoryV3 again with
/// this Executor and the new oracle given, and binds the Executor to both
/// (BindExecutorV3). It passes FUND_CONFIG (the same JSON as `pnpm deploy:fund`;
/// only the pools whose tokens the registry lists are seeded),
/// EXECUTOR_V3_TOKEN_REGISTRY and EXECUTOR_V3_AGENT_NFT. CREATE2 with the
/// `alpha-agents.<name>.v3` salts: running it again finds the same contracts.
contract DeployExecutorV3 is DeployFund {
    bytes32 public constant ROUTER_ID = keccak256("route-adapter");

    /// Executor v3's launch policy (FINAL_PLAN 6.3, D-352, D-337): packages/policy's executorV3.LAUNCH_POLICY.
    function launchPolicy() public pure returns (PolicyV3 memory) {
        return PolicyV3({
            maxTradeBps: 1_000,
            maxAssetBps: 4_000,
            minUsdcBps: 1_000,
            maxSlippageBps: 50,
            maxSlippageClassABps: 100,
            maxClassAPositionBps: 1_500,
            maxClassATotalBps: 5_000,
            maxTurnoverBps: 10_000,
            maxTradesPerWindow: 20,
            windowSeconds: 86_400,
            deadlineSeconds: 120
        });
    }

    function run() external override {
        string memory json = vm.envString("FUND_CONFIG");
        TokenRegistry tokens = TokenRegistry(vm.envAddress("EXECUTOR_V3_TOKEN_REGISTRY"));
        address agentNft = vm.envAddress("EXECUTOR_V3_AGENT_NFT");
        require(address(tokens).code.length > 0, "TokenRegistry missing: run pnpm deploy:fund");
        require(agentNft.code.length > 0, "AgentNFT missing: run pnpm deploy:agent-nft");
        address usdc = vm.parseJsonAddress(json, ".usdc");
        address wmon = vm.parseJsonAddress(json, ".wmon");
        require(tokens.tokenRecord(usdc).lane == Lane.CORE, "USDC is not a core token of the registry");
        require(tokens.tokenRecord(wmon).lane == Lane.CORE, "WMON is not a core token of the registry");

        ExecutorV3 executor = _deployExecutor(json, tokens, agentNft);
        (RouteAdapter router, ProtocolRegistryV3 pools) = _deploySet(json, tokens, executor);
        OracleAdapterV3 oracle = _deployOracle(json, tokens, pools);
        require(address(oracle.POOLS()) == address(pools), "the oracle reads another registry");

        console.log("EXECUTOR_V3_ADDRESS", address(executor));
        console.log("EXECUTOR_V3_CODE_SIZE", address(executor).code.length);
        console.log("EXECUTOR_ROUTE_ADAPTER_V3_ADDRESS", address(router));
        console.log("EXECUTOR_ROUTE_ADAPTER_V3_CODE_SIZE", address(router).code.length);
        console.log("PROTOCOL_REGISTRY_V3_ADDRESS", address(pools));
        console.log("PROTOCOL_REGISTRY_V3_CODE_SIZE", address(pools).code.length);
        console.log("ORACLE_ADAPTER_V3_ADDRESS", address(oracle));
        console.log("ORACLE_ADAPTER_V3_CODE_SIZE", address(oracle).code.length);
        console.log("CORE_POOLS", pools.poolCount());
        console.log("EXECUTOR_V3_POLICY_HASH");
        console.logBytes32(executor.policyHash());
    }

    function _deployExecutor(string memory json, TokenRegistry tokens, address agentNft)
        internal
        returns (ExecutorV3 executor)
    {
        address admin = vm.parseJsonAddress(json, ".admin");
        address guardian = vm.parseJsonAddress(json, ".guardian");
        bytes memory args = abi.encode(
            admin,
            guardian,
            IAgentNFTView(agentNft),
            ITokenRegistry(address(tokens)),
            vm.parseJsonAddress(json, ".usdc"),
            vm.parseJsonAddress(json, ".wmon"),
            launchPolicy()
        );
        executor =
            ExecutorV3(_create2(salt("executor", SALT_VERSION), abi.encodePacked(type(ExecutorV3).creationCode, args)));
        require(executor.owner() == admin && executor.guardian() == guardian, "executor roles");
        require(address(executor.TOKENS()) == address(tokens), "executor registry");
        require(executor.policyHash() == keccak256(abi.encode(launchPolicy())), "executor policy");
    }

    /// The adapter and the registry from one ExecutorSetDeployer, itself deployed by CREATE2 from its arguments.
    function _deploySet(string memory json, TokenRegistry tokens, ExecutorV3 executor)
        internal
        returns (RouteAdapter router, ProtocolRegistryV3 pools)
    {
        ExecutorSetDeployer.Args memory a = ExecutorSetDeployer.Args({
            admin: vm.parseJsonAddress(json, ".admin"),
            guardian: vm.parseJsonAddress(json, ".guardian"),
            screener: vm.parseJsonAddress(json, ".screener"),
            tokens: ITokenRegistry(address(tokens)),
            venues: _venues(json),
            pools: _corePools(json, tokens),
            adapterId: ROUTER_ID,
            executor: address(executor),
            poolManager: vm.parseJsonAddress(json, ".poolManager"),
            wmon: vm.parseJsonAddress(json, ".wmon"),
            usdc: vm.parseJsonAddress(json, ".usdc")
        });
        ExecutorSetDeployer deployer = ExecutorSetDeployer(
            _create2(
                salt("executor-set", SALT_VERSION),
                abi.encodePacked(type(ExecutorSetDeployer).creationCode, abi.encode(a))
            )
        );
        router = deployer.ROUTER();
        pools = deployer.REGISTRY();
        require(pools.adapterFor(ROUTER_ID) == address(router), "the adapter is not active in the registry");
        require(address(router.REGISTRY()) == address(pools), "the adapter reads another registry");
        require(router.EXECUTOR() == address(executor), "the adapter answers another Executor");
        require(pools.owner() == a.admin, "registry roles");
        console.log("EXECUTOR_SET_DEPLOYER_ADDRESS", address(deployer));
    }

    /// The configured pools whose tokens the registry lists as core; the rest are left out and named.
    function _corePools(string memory json, TokenRegistry tokens)
        internal
        view
        returns (ProtocolRegistryV3.PoolSeed[] memory out)
    {
        ProtocolRegistryV3.PoolSeed[] memory all = _pools(json);
        address wmon = vm.parseJsonAddress(json, ".wmon");
        uint256 n;
        bool[] memory keep = new bool[](all.length);
        for (uint256 i = 0; i < all.length; ++i) {
            address t0 = all[i].token0 == address(0) ? wmon : all[i].token0;
            address t1 = all[i].token1 == address(0) ? wmon : all[i].token1;
            keep[i] = tokens.tokenRecord(t0).lane == Lane.CORE && tokens.tokenRecord(t1).lane == Lane.CORE;
            if (keep[i]) ++n;
            else console.log("POOL_LEFT_OUT", all[i].token0, all[i].token1, all[i].fee);
        }
        out = new ProtocolRegistryV3.PoolSeed[](n);
        uint256 k;
        for (uint256 i = 0; i < all.length; ++i) {
            if (keep[i]) out[k++] = all[i];
        }
    }
}
