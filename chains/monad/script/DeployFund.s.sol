// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console} from "forge-std/Script.sol";
import {FeedConfig, FeedLeg, IPoolRegistry, ITokenRegistry, Lane, PriceClass, Venue} from "../src/interfaces/IFund.sol";
import {IPoolManager} from "../src/interfaces/IUniswap.sol";
import {IUniswapV4StateView} from "../src/interfaces/IOracle.sol";
import {OracleAdapterV3} from "../src/fund/OracleAdapterV3.sol";
import {ProtocolRegistryV3} from "../src/fund/ProtocolRegistryV3.sol";
import {RouteAdapter} from "../src/fund/RouteAdapter.sol";
import {TokenRegistry} from "../src/fund/TokenRegistry.sol";
import {DeployScope} from "./DeployScope.sol";

/// Deploys the fund agent's v3 set (F-U2) beside v1 and v2: the TokenRegistry
/// with its core lane seeded, the ProtocolRegistryV3 with the core pools, the
/// OracleAdapterV3 and a RouteAdapter. Run by `pnpm deploy:fund` (scripts/lib/fund.js),
/// which decides the seeds (each core token re-screened at deploy time) and
/// passes everything as FUND_CONFIG, a JSON string. CREATE2 with the
/// `alpha-agents.fund-<name>.v3` salts: running it again with the same seeds
/// finds the same contracts. Nothing that exists is touched.
///
/// The RouteAdapter here is not registered: its Executor is the given demo
/// executor. F-U4 deploys the adapter bound to Executor v3 and registers it.
contract DeployFund is DeployScope {
    uint256 internal constant SALT_VERSION = 3;

    struct SeedJson {
        address token;
        uint256 maxPositionBps;
        address usdFeed;
        uint256 usdDecimals;
        uint256 usdMaxAge;
        address rateFeed;
        uint256 rateDecimals;
        uint256 rateMaxAge;
    }

    struct PoolJson {
        uint256 venue;
        address token0;
        address token1;
        uint256 fee;
        int256 tickSpacing;
        address pool;
    }

    function run() external {
        string memory json = vm.envString("FUND_CONFIG");
        TokenRegistry tokens = _deployTokens(json);
        ProtocolRegistryV3 pools = _deployPools(json, tokens);
        OracleAdapterV3 oracle = _deployOracle(json, tokens, pools);
        RouteAdapter adapter = _deployAdapter(json, pools);

        console.log("TOKEN_REGISTRY_ADDRESS", address(tokens));
        console.log("TOKEN_REGISTRY_CODE_SIZE", address(tokens).code.length);
        console.log("PROTOCOL_REGISTRY_V3_ADDRESS", address(pools));
        console.log("PROTOCOL_REGISTRY_V3_CODE_SIZE", address(pools).code.length);
        console.log("ORACLE_ADAPTER_V3_ADDRESS", address(oracle));
        console.log("ORACLE_ADAPTER_V3_CODE_SIZE", address(oracle).code.length);
        console.log("ROUTE_ADAPTER_ADDRESS", address(adapter));
        console.log("ROUTE_ADAPTER_CODE_SIZE", address(adapter).code.length);
        console.log("CORE_TOKENS", tokens.tokenCount());
        console.log("CORE_POOLS", pools.poolCount());
        for (uint256 i = 0; i < tokens.tokenCount(); ++i) {
            address t = tokens.tokens(i);
            require(tokens.tokenRecord(t).lane == Lane.CORE, "seeded tokens are core");
            console.log("CORE_TOKEN", t);
        }
    }

    function _deployTokens(string memory json) internal returns (TokenRegistry tokens) {
        address admin = vm.parseJsonAddress(json, ".admin");
        address screener = vm.parseJsonAddress(json, ".screener");
        tokens = TokenRegistry(
            _create2(
                salt("fund-token-registry", SALT_VERSION),
                abi.encodePacked(
                    type(TokenRegistry).creationCode,
                    abi.encode(admin, vm.parseJsonAddress(json, ".guardian"), screener, _seeds(json))
                )
            )
        );
        require(tokens.owner() == admin && tokens.screener() == screener, "token registry roles");
    }

    function _venues(string memory json) internal pure returns (ProtocolRegistryV3.Venues memory) {
        return ProtocolRegistryV3.Venues({
            uniswapV3Factory: vm.parseJsonAddress(json, ".uniswapV3Factory"),
            pancakeswapV3Factory: vm.parseJsonAddress(json, ".pancakeswapV3Factory"),
            poolManager: vm.parseJsonAddress(json, ".poolManager"),
            stateView: IUniswapV4StateView(vm.parseJsonAddress(json, ".stateView")),
            wmon: vm.parseJsonAddress(json, ".wmon"),
            usdc: vm.parseJsonAddress(json, ".usdc")
        });
    }

    function _deployPools(string memory json, TokenRegistry tokens) internal returns (ProtocolRegistryV3 pools) {
        address admin = vm.parseJsonAddress(json, ".admin");
        bytes memory args = abi.encode(
            admin,
            vm.parseJsonAddress(json, ".guardian"),
            vm.parseJsonAddress(json, ".screener"),
            ITokenRegistry(address(tokens)),
            _venues(json),
            _pools(json),
            new bytes32[](0),
            new address[](0)
        );
        pools = ProtocolRegistryV3(
            _create2(
                salt("fund-protocol-registry", SALT_VERSION),
                abi.encodePacked(type(ProtocolRegistryV3).creationCode, args)
            )
        );
        require(pools.owner() == admin, "protocol registry roles");
    }

    function _deployOracle(string memory json, TokenRegistry tokens, ProtocolRegistryV3 pools)
        internal
        returns (OracleAdapterV3)
    {
        bytes memory args = abi.encode(
            ITokenRegistry(address(tokens)),
            IPoolRegistry(address(pools)),
            IUniswapV4StateView(vm.parseJsonAddress(json, ".stateView")),
            vm.parseJsonAddress(json, ".usdc"),
            vm.parseJsonAddress(json, ".wmon"),
            vm.parseJsonUint(json, ".maxDeviationBps")
        );
        return OracleAdapterV3(
            _create2(salt("fund-oracle", SALT_VERSION), abi.encodePacked(type(OracleAdapterV3).creationCode, args))
        );
    }

    function _deployAdapter(string memory json, ProtocolRegistryV3 pools) internal returns (RouteAdapter) {
        bytes memory args = abi.encode(
            IPoolRegistry(address(pools)),
            IPoolManager(vm.parseJsonAddress(json, ".poolManager")),
            vm.parseJsonAddress(json, ".wmon"),
            vm.parseJsonAddress(json, ".usdc"),
            vm.parseJsonAddress(json, ".demoExecutor")
        );
        return RouteAdapter(
            payable(_create2(
                    salt("fund-route-adapter", SALT_VERSION), abi.encodePacked(type(RouteAdapter).creationCode, args)
                ))
        );
    }

    function _seeds(string memory json) internal pure returns (TokenRegistry.CoreSeed[] memory out) {
        SeedJson[] memory s = abi.decode(
            vm.parseJsonTypeArray(
                json,
                ".seeds",
                "SeedJson(address token,uint256 maxPositionBps,address usdFeed,uint256 usdDecimals,uint256 usdMaxAge,address rateFeed,uint256 rateDecimals,uint256 rateMaxAge)"
            ),
            (SeedJson[])
        );
        out = new TokenRegistry.CoreSeed[](s.length);
        for (uint256 i = 0; i < s.length; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            FeedLeg memory usd = FeedLeg(s[i].usdFeed, uint8(s[i].usdDecimals), uint32(s[i].usdMaxAge));
            FeedLeg memory rate;
            // forge-lint: disable-next-line(unsafe-typecast)
            if (s[i].rateFeed != address(0)) {
                rate = FeedLeg(s[i].rateFeed, uint8(s[i].rateDecimals), uint32(s[i].rateMaxAge));
            }
            // forge-lint: disable-next-line(unsafe-typecast)
            out[i] =
                TokenRegistry.CoreSeed(s[i].token, PriceClass.F, uint16(s[i].maxPositionBps), FeedConfig(usd, rate));
        }
    }

    function _pools(string memory json) internal pure returns (ProtocolRegistryV3.PoolSeed[] memory out) {
        PoolJson[] memory p = abi.decode(
            vm.parseJsonTypeArray(
                json,
                ".pools",
                "PoolJson(uint256 venue,address token0,address token1,uint256 fee,int256 tickSpacing,address pool)"
            ),
            (PoolJson[])
        );
        out = new ProtocolRegistryV3.PoolSeed[](p.length);
        for (uint256 i = 0; i < p.length; ++i) {
            out[i] = ProtocolRegistryV3.PoolSeed(
                // forge-lint: disable-next-line(unsafe-typecast)
                Venue(uint8(p[i].venue)),
                p[i].token0,
                p[i].token1,
                // forge-lint: disable-next-line(unsafe-typecast)
                uint24(p[i].fee),
                // forge-lint: disable-next-line(unsafe-typecast)
                int24(p[i].tickSpacing),
                p[i].pool
            );
        }
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
}
