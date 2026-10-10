// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console} from "forge-std/Script.sol";
import {ExecutorV3} from "../src/fund/ExecutorV3.sol";
import {IExecutorFactoryV3} from "../src/interfaces/IExecutorV3.sol";
import {IPoolRegistry} from "../src/interfaces/IFund.sol";
import {DeployScope} from "./DeployScope.sol";

/// Binds Executor v3 to the AccountFactoryV3 deployed with it and to its
/// ProtocolRegistryV3 (F-U4, D-361), once, as the Executor's admin. Run by
/// `pnpm deploy:executor-v3` after the factory exists; EXECUTOR_V3,
/// EXECUTOR_V3_FACTORY and EXECUTOR_V3_POOLS name the three.
contract BindExecutorV3 is DeployScope {
    function run() external {
        ExecutorV3 executor = ExecutorV3(vm.envAddress("EXECUTOR_V3"));
        IExecutorFactoryV3 factory = IExecutorFactoryV3(vm.envAddress("EXECUTOR_V3_FACTORY"));
        IPoolRegistry pools = IPoolRegistry(vm.envAddress("EXECUTOR_V3_POOLS"));
        require(address(executor).code.length > 0 && address(factory).code.length > 0, "contracts missing");
        require(address(pools).code.length > 0, "registry missing");
        require(factory.executor() == address(executor), "the factory names another Executor");
        if (address(executor.factory()) != address(0)) {
            require(address(executor.factory()) == address(factory), "Executor v3 is bound to another factory");
            require(address(executor.pools()) == address(pools), "Executor v3 is bound to another registry");
            console.log("Executor v3 already bound");
        } else {
            _startBroadcast();
            executor.bind(factory, pools);
            vm.stopBroadcast();
        }
        console.log("EXECUTOR_V3_BOUND_FACTORY", address(executor.factory()));
        console.log("EXECUTOR_V3_BOUND_POOLS", address(executor.pools()));
    }
}
