// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console} from "forge-std/Script.sol";
import {DeployScope} from "./DeployScope.sol";
import {AccountFactory} from "../src/custody/AccountFactory.sol";
import {PersonalAccount} from "../src/custody/PersonalAccount.sol";
import {Executor} from "../src/executor/Executor.sol";
import {ProtocolRegistry} from "../src/executor/ProtocolRegistry.sol";
import {OracleAdapter} from "../src/oracle/OracleAdapter.sol";
import {UniswapV3UsdcWmonAdapter} from "../src/venues/UniswapV3UsdcWmonAdapter.sol";
import {UniswapV4MonUsdcAdapter} from "../src/venues/UniswapV4MonUsdcAdapter.sol";
import {IAgentNFTView} from "../src/interfaces/ICustody.sol";
import {IExecutorFactory, Policy} from "../src/interfaces/IExecutor.sol";
import {IChainlinkFeed, IUniswapV4StateView} from "../src/interfaces/IOracle.sol";
import {IPoolManager, ISwapRouter02} from "../src/interfaces/IUniswap.sol";

/// Deploys the trading stack through the deterministic CREATE2 factory, in
/// the order D-235 sets: the oracle adapter (P2-U3), the Executor (P2-U2),
/// the Uniswap v4 and v3 venue adapters, the ProtocolRegistry (v4 active, v3
/// registered but paused), then AccountFactory (and with it the
/// PersonalAccount implementation) with the adapter and the Executor, and
/// finally binds the Executor to the factory and registry. An existing
/// deployment is found, not repeated. The onchain state is asserted (MV-S15).
/// Run it through `pnpm deploy:account-factory` (the local fork) or
/// `pnpm deploy:testnet` (Monad testnet, P2-EC: the `p2ec.testnet` salts, the
/// TestnetFeed feeds, the P2-EC pool and no v3 fallback, since testnet has no
/// Uniswap v3), which set these variables:
///   ACCOUNT_FACTORY_ADMIN, ACCOUNT_FACTORY_GUARDIAN, ACCOUNT_FACTORY_SENTINEL,
///   ACCOUNT_FACTORY_AGENT_NFT, ACCOUNT_FACTORY_USDC, ACCOUNT_FACTORY_WMON,
///   ACCOUNT_FACTORY_PERSONAL_CAP, ACCOUNT_FACTORY_PLATFORM_CAP,
///   ACCOUNT_FACTORY_ALLOWLIST (comma-separated), ORACLE_MON_USD_FEED,
///   ORACLE_USDC_USD_FEED, ORACLE_STATE_VIEW, ORACLE_POOL_ID, VENUE_POOL_MANAGER
///   and VENUE_V3_ROUTER (unset or zero: no v3 adapter is deployed or
///   registered); DEPLOYER_PRIVATE_KEY and DEPLOY_SALT_SCOPE on testnet.
contract DeployAccountFactory is DeployScope {
    /// Salt names; on the fork each salt is `alpha-agents.<name>.v1` (DeployScope).
    string public constant SALT_NAME = "account-factory";
    string public constant ORACLE_SALT_NAME = "oracle-adapter";
    string public constant EXECUTOR_SALT_NAME = "executor";
    string public constant V4_SALT_NAME = "venue.uniswap-v4-mon-usdc-500";
    string public constant V3_SALT_NAME = "venue.uniswap-v3-usdc-wmon-3000";
    string public constant REGISTRY_SALT_NAME = "protocol-registry";
    /// The registry's adapter IDs.
    bytes32 public constant V4_ID = keccak256("uniswap-v4-mon-usdc-500");
    bytes32 public constant V3_ID = keccak256("uniswap-v3-usdc-wmon-3000");

    /// The launch oracle rules (D-151, D-168, FINAL_PLAN 4.1.9, A-34); packages/policy's LAUNCH_LIMITS holds the same.
    uint256 internal constant MON_USD_MAX_AGE = 300;
    uint256 internal constant USDC_USD_MAX_AGE = 3_900;
    uint8 internal constant FEED_DECIMALS = 8;
    uint256 internal constant MAX_DEVIATION_BPS = 200;
    uint256 internal constant MAX_DEPEG_BPS = 100;

    struct Config {
        address admin;
        address guardian;
        address sentinel;
        address oracle;
        address executor;
        address agentNft;
        address usdc;
        address wmon;
        uint256 personalCap;
        uint256 platformCap;
        address[] allowlist;
    }

    function run() external returns (AccountFactory factory) {
        // The fork or, with the p2ec scope, testnet; mainnet is PB-U1's (DeployScope).
        bytes32 factorySalt = salt(SALT_NAME);
        OracleAdapter adapter = _deployOracle();
        Executor executor = _deployExecutor();
        ProtocolRegistry registry = _deployVenues(executor);
        Config memory c = Config({
            admin: vm.envAddress("ACCOUNT_FACTORY_ADMIN"),
            guardian: vm.envAddress("ACCOUNT_FACTORY_GUARDIAN"),
            sentinel: vm.envAddress("ACCOUNT_FACTORY_SENTINEL"),
            oracle: address(adapter),
            executor: address(executor),
            agentNft: vm.envAddress("ACCOUNT_FACTORY_AGENT_NFT"),
            usdc: vm.envAddress("ACCOUNT_FACTORY_USDC"),
            wmon: vm.envAddress("ACCOUNT_FACTORY_WMON"),
            personalCap: vm.envUint("ACCOUNT_FACTORY_PERSONAL_CAP"),
            platformCap: vm.envUint("ACCOUNT_FACTORY_PLATFORM_CAP"),
            allowlist: vm.envAddress("ACCOUNT_FACTORY_ALLOWLIST", ",")
        });
        require(c.agentNft.code.length > 0, "AgentNFT missing: run pnpm deploy:agent-nft");
        require(c.usdc.code.length > 0 && c.wmon.code.length > 0, "USDC or WMON missing");
        require(CREATE2_FACTORY.code.length > 0, "CREATE2 factory missing");

        bytes memory initCode = abi.encodePacked(
            type(AccountFactory).creationCode,
            abi.encode(
                c.admin,
                c.guardian,
                c.sentinel,
                c.oracle,
                c.executor,
                c.agentNft,
                c.usdc,
                c.wmon,
                c.personalCap,
                c.platformCap,
                c.allowlist
            )
        );
        address predicted = vm.computeCreate2Address(factorySalt, keccak256(initCode), CREATE2_FACTORY);

        bool fresh = predicted.code.length == 0;
        if (!fresh) {
            console.log("AccountFactory already deployed");
            factory = AccountFactory(predicted);
        } else {
            _startBroadcast();
            factory = new AccountFactory{salt: factorySalt}(
                c.admin,
                c.guardian,
                c.sentinel,
                c.oracle,
                c.executor,
                IAgentNFTView(c.agentNft),
                c.usdc,
                c.wmon,
                c.personalCap,
                c.platformCap,
                c.allowlist
            );
            vm.stopBroadcast();
            require(address(factory) == predicted, "deployed address differs from prediction");
        }

        _assertImmutables(factory, c);
        if (fresh) _assertInitialState(factory, c);
        _bind(executor, factory, registry);
        console.log("ORACLE_ADAPTER_ADDRESS", address(adapter));
        console.log("ORACLE_ADAPTER_CODE_SIZE", address(adapter).code.length);
        console.log("EXECUTOR_ADDRESS", address(executor));
        console.log("EXECUTOR_CODE_SIZE", address(executor).code.length);
        console.log("PROTOCOL_REGISTRY_ADDRESS", address(registry));
        console.log("PROTOCOL_REGISTRY_CODE_SIZE", address(registry).code.length);
        console.log("VENUE_V4_ADDRESS", registry.entry(V4_ID).adapter);
        console.log("VENUE_V4_CODE_SIZE", registry.entry(V4_ID).adapter.code.length);
        if (_hasV3()) {
            console.log("VENUE_V3_ADDRESS", registry.entry(V3_ID).adapter);
            console.log("VENUE_V3_CODE_SIZE", registry.entry(V3_ID).adapter.code.length);
        }
        console.log("ACCOUNT_FACTORY_ADDRESS", address(factory));
        console.log("ACCOUNT_FACTORY_CODE_SIZE", address(factory).code.length);
        console.log("PERSONAL_ACCOUNT_IMPLEMENTATION", factory.PERSONAL_ACCOUNT_IMPLEMENTATION());
        console.log("PERSONAL_ACCOUNT_CODE_SIZE", factory.PERSONAL_ACCOUNT_IMPLEMENTATION().code.length);
        console.log("ACCOUNT_FACTORY_SALT");
        console.logBytes32(factorySalt);
    }

    /// The v3 fallback is deployed only where SwapRouter02 exists (not on testnet).
    function _hasV3() internal view returns (bool) {
        return vm.envOr("VENUE_V3_ROUTER", address(0)) != address(0);
    }

    /// The launch hard limits (FINAL_PLAN 6.3); packages/policy's LAUNCH_EXECUTOR_POLICY holds the same.
    function launchPolicy() public pure returns (Policy memory) {
        return Policy({
            maxTradeBps: 1_000,
            maxAssetBps: 4_000,
            minUsdcBps: 1_000,
            maxSlippageBps: 50,
            maxTurnoverBps: 10_000,
            maxTradesPerWindow: 20,
            windowSeconds: 86_400,
            deadlineSeconds: 120
        });
    }

    /// Deploys `initCode` at its CREATE2 address unless code is already there.
    function _create2(bytes32 salt_, bytes memory initCode) internal returns (address addr) {
        addr = vm.computeCreate2Address(salt_, keccak256(initCode), CREATE2_FACTORY);
        if (addr.code.length != 0) return addr;
        _startBroadcast();
        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(salt_, initCode));
        vm.stopBroadcast();
        require(ok && addr.code.length != 0, "CREATE2 deployment failed");
    }

    function _deployExecutor() internal returns (Executor executor) {
        address admin = vm.envAddress("ACCOUNT_FACTORY_ADMIN");
        address guardian = vm.envAddress("ACCOUNT_FACTORY_GUARDIAN");
        bytes memory init = abi.encodePacked(
            type(Executor).creationCode,
            abi.encode(
                admin,
                guardian,
                vm.envAddress("ACCOUNT_FACTORY_AGENT_NFT"),
                vm.envAddress("ACCOUNT_FACTORY_USDC"),
                vm.envAddress("ACCOUNT_FACTORY_WMON"),
                launchPolicy()
            )
        );
        executor = Executor(_create2(salt(EXECUTOR_SALT_NAME), init));
        require(executor.owner() == admin && executor.guardian() == guardian, "executor roles");
        require(executor.policyHash() == keccak256(abi.encode(launchPolicy())), "executor policy");
        require(address(executor.AGENT_NFT()) == vm.envAddress("ACCOUNT_FACTORY_AGENT_NFT"), "executor agent nft");
    }

    /// The v4 adapter (active), the v3 fallback (registered, paused) where v3
    /// exists, and the registry that lists them.
    function _deployVenues(Executor executor) internal returns (ProtocolRegistry registry) {
        address usdc = vm.envAddress("ACCOUNT_FACTORY_USDC");
        address wmon = vm.envAddress("ACCOUNT_FACTORY_WMON");
        address pm = vm.envAddress("VENUE_POOL_MANAGER");
        bool hasV3 = _hasV3();
        address router = vm.envOr("VENUE_V3_ROUTER", address(0));
        require(pm.code.length > 0 && (!hasV3 || router.code.length > 0), "venues missing");
        address v4 = _create2(
            salt(V4_SALT_NAME),
            abi.encodePacked(
                type(UniswapV4MonUsdcAdapter).creationCode,
                abi.encode(IPoolManager(pm), usdc, wmon, address(executor), vm.envBytes32("ORACLE_POOL_ID"))
            )
        );
        address v3 = hasV3
            ? _create2(
                salt(V3_SALT_NAME),
                abi.encodePacked(
                    type(UniswapV3UsdcWmonAdapter).creationCode,
                    abi.encode(ISwapRouter02(router), usdc, wmon, address(executor))
                )
            )
            : address(0);
        uint256 n = hasV3 ? 2 : 1;
        bytes32[] memory ids = new bytes32[](n);
        address[] memory adapters = new address[](n);
        ProtocolRegistry.Status[] memory statuses = new ProtocolRegistry.Status[](n);
        ids[0] = V4_ID;
        adapters[0] = v4;
        statuses[0] = ProtocolRegistry.Status.ACTIVE;
        if (hasV3) {
            ids[1] = V3_ID;
            adapters[1] = v3;
            statuses[1] = ProtocolRegistry.Status.PAUSED;
        }
        registry = ProtocolRegistry(
            _create2(
                salt(REGISTRY_SALT_NAME),
                abi.encodePacked(
                    type(ProtocolRegistry).creationCode,
                    abi.encode(
                        vm.envAddress("ACCOUNT_FACTORY_ADMIN"),
                        vm.envAddress("ACCOUNT_FACTORY_GUARDIAN"),
                        usdc,
                        ids,
                        adapters,
                        statuses
                    )
                )
            )
        );
        require(UniswapV4MonUsdcAdapter(payable(v4)).EXECUTOR() == address(executor), "v4 executor");
        require(registry.entry(V4_ID).adapter == v4, "registry v4 adapter");
        require(registry.adapterFor(V4_ID, wmon, usdc) == v4, "v4 active");
        if (hasV3) {
            require(UniswapV3UsdcWmonAdapter(v3).EXECUTOR() == address(executor), "v3 executor");
            require(registry.entry(V3_ID).adapter == v3, "registry v3 adapter");
            require(registry.adapterFor(V3_ID, wmon, usdc) == address(0), "v3 paused");
        } else {
            require(registry.entry(V3_ID).adapter == address(0), "no v3 adapter without v3");
        }
    }

    /// Binds the Executor to the factory and registry once; checks the binding every run.
    function _bind(Executor executor, AccountFactory factory, ProtocolRegistry registry) internal {
        if (address(executor.factory()) == address(0)) {
            _startBroadcast();
            executor.bind(IExecutorFactory(address(factory)), registry);
            vm.stopBroadcast();
        }
        require(address(executor.factory()) == address(factory), "executor factory");
        require(address(executor.registry()) == address(registry), "executor registry");
        require(factory.executor() == address(executor), "factory executor");
    }

    /// The adapter with the launch rules over the real feeds and pool, found
    /// if it exists; every setting is immutable, so it is checked every run.
    function _deployOracle() internal returns (OracleAdapter adapter) {
        OracleAdapter.Config memory o = OracleAdapter.Config({
            usdc: vm.envAddress("ACCOUNT_FACTORY_USDC"),
            wmon: vm.envAddress("ACCOUNT_FACTORY_WMON"),
            monUsdFeed: IChainlinkFeed(vm.envAddress("ORACLE_MON_USD_FEED")),
            monUsdDecimals: FEED_DECIMALS,
            monUsdMaxAge: MON_USD_MAX_AGE,
            usdcUsdFeed: IChainlinkFeed(vm.envAddress("ORACLE_USDC_USD_FEED")),
            usdcUsdDecimals: FEED_DECIMALS,
            usdcUsdMaxAge: USDC_USD_MAX_AGE,
            stateView: IUniswapV4StateView(vm.envAddress("ORACLE_STATE_VIEW")),
            poolId: vm.envBytes32("ORACLE_POOL_ID"),
            maxDeviationBps: MAX_DEVIATION_BPS,
            maxDepegBps: MAX_DEPEG_BPS
        });
        require(address(o.monUsdFeed).code.length > 0 && address(o.usdcUsdFeed).code.length > 0, "feeds missing");
        require(address(o.stateView).code.length > 0, "StateView missing");
        bytes memory initCode = abi.encodePacked(type(OracleAdapter).creationCode, abi.encode(o));
        bytes32 oracleSalt = salt(ORACLE_SALT_NAME);
        address predicted = vm.computeCreate2Address(oracleSalt, keccak256(initCode), CREATE2_FACTORY);
        if (predicted.code.length == 0) {
            _startBroadcast();
            adapter = new OracleAdapter{salt: oracleSalt}(o);
            vm.stopBroadcast();
            require(address(adapter) == predicted, "adapter address differs from prediction");
        } else {
            adapter = OracleAdapter(predicted);
        }
        require(adapter.USDC() == o.usdc && adapter.WMON() == o.wmon, "adapter assets");
        require(address(adapter.MON_USD_FEED()) == address(o.monUsdFeed), "MON/USD feed");
        require(address(adapter.USDC_USD_FEED()) == address(o.usdcUsdFeed), "USDC/USD feed");
        require(adapter.MON_USD_MAX_AGE() == MON_USD_MAX_AGE && adapter.USDC_USD_MAX_AGE() == USDC_USD_MAX_AGE, "ages");
        require(adapter.MON_USD_DECIMALS() == FEED_DECIMALS && adapter.USDC_USD_DECIMALS() == FEED_DECIMALS, "decimals");
        require(address(adapter.STATE_VIEW()) == address(o.stateView) && adapter.POOL_ID() == o.poolId, "pool");
        require(adapter.MAX_DEVIATION_BPS() == MAX_DEVIATION_BPS && adapter.MAX_DEPEG_BPS() == MAX_DEPEG_BPS, "bounds");
    }

    /// What can never change after deployment.
    function _assertImmutables(AccountFactory f, Config memory c) internal view {
        require(address(f.AGENT_NFT()) == c.agentNft, "agent nft");
        require(f.USDC() == c.usdc && f.WMON() == c.wmon, "assets");
        require(f.RISK_TIMELOCK() == 9 days, "timelock");
        PersonalAccount impl = PersonalAccount(f.PERSONAL_ACCOUNT_IMPLEMENTATION());
        require(address(impl).code.length > 0, "implementation");
        require(address(impl.AGENT_NFT()) == c.agentNft, "implementation agent nft");
        require(impl.USDC() == c.usdc && impl.WMON() == c.wmon, "implementation assets");
    }

    /// A fresh deployment must be exactly what was intended. A later run
    /// against an existing deployment skips this, since the admin may have
    /// changed the settings since (MV-S15: Veda's live config drifted from its repo).
    function _assertInitialState(AccountFactory f, Config memory c) internal view {
        require(f.owner() == c.admin, "admin");
        require(f.pendingOwner() == address(0), "no pending admin");
        require(f.guardian() == c.guardian && f.sentinel() == c.sentinel, "roles");
        // Given at deployment (Q-47, D-235); every later change waits the timelock.
        require(f.executor() == c.executor, "executor at deploy");
        require(f.oracle() == c.oracle, "oracle at deploy");
        require(f.personalCap() == c.personalCap && f.platformCap() == c.platformCap, "caps");
        require(f.platformTotal() == 0, "nothing deposited at deploy");
        require(f.allowlistEnabled(), "allowlist on at deploy");
        for (uint256 i = 0; i < c.allowlist.length; i++) {
            require(f.isAllowlisted(c.allowlist[i]), "allowlist entry");
        }
        require(f.isBuyable(c.usdc) && f.isBuyable(c.wmon), "buy list");
    }
}
