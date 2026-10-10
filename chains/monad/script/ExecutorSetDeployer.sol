// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProtocolRegistryV3} from "../src/fund/ProtocolRegistryV3.sol";
import {RouteAdapter} from "../src/fund/RouteAdapter.sol";
import {IPoolRegistry, ITokenRegistry} from "../src/interfaces/IFund.sol";
import {IPoolManager} from "../src/interfaces/IUniswap.sol";

/// Deploys Executor v3's RouteAdapter and the ProtocolRegistryV3 that lists it
/// from its construction, in its own constructor (F-U4, D-363). The adapter
/// needs the registry's address and the registry pins the adapter's code, so
/// neither can be deployed by CREATE2 before the other; from inside this
/// contract both come from CREATE at its nonces 1 and 2, and this contract is
/// itself deployed by CREATE2 from its arguments, so every address follows
/// from the arguments alone, the same on every fork and chain. Deployment
/// tooling, not protocol code: it holds no funds and no role.
contract ExecutorSetDeployer {
    struct Args {
        address admin;
        address guardian;
        address screener;
        ITokenRegistry tokens;
        ProtocolRegistryV3.Venues venues;
        ProtocolRegistryV3.PoolSeed[] pools;
        bytes32 adapterId;
        address executor;
        address poolManager;
        address wmon;
        address usdc;
    }

    RouteAdapter public immutable ROUTER;
    ProtocolRegistryV3 public immutable REGISTRY;

    event ExecutorSetDeployed(address indexed router, address indexed registry, address indexed executor);

    constructor(Args memory a) {
        address predictedRouter = _createAddress(1);
        address predictedRegistry = _createAddress(2);
        RouteAdapter router =
            new RouteAdapter(IPoolRegistry(predictedRegistry), IPoolManager(a.poolManager), a.wmon, a.usdc, a.executor);
        require(address(router) == predictedRouter, "adapter address");
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = a.adapterId;
        address[] memory adapters = new address[](1);
        adapters[0] = address(router);
        ProtocolRegistryV3 registry =
            new ProtocolRegistryV3(a.admin, a.guardian, a.screener, a.tokens, a.venues, a.pools, ids, adapters);
        require(address(registry) == predictedRegistry, "registry address");
        require(registry.adapterFor(a.adapterId) == address(router), "adapter not active");
        ROUTER = router;
        REGISTRY = registry;
        emit ExecutorSetDeployed(address(router), address(registry), a.executor);
    }

    /// The address CREATE gives this contract's deployment at a nonce below 128.
    function _createAddress(uint8 nonce) internal view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), address(this), bytes1(nonce)))))
        );
    }
}
