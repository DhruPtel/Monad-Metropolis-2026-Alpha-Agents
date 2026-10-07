// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console} from "forge-std/Script.sol";
import {AccountFactory} from "../src/custody/AccountFactory.sol";
import {PersonalAccount} from "../src/custody/PersonalAccount.sol";
import {OracleAdapter} from "../src/oracle/OracleAdapter.sol";
import {IAgentNFTView} from "../src/interfaces/ICustody.sol";
import {IChainlinkFeed, IUniswapV4StateView} from "../src/interfaces/IOracle.sol";

/// Deploys the oracle adapter (P2-U3) and AccountFactory (and with it the
/// PersonalAccount implementation) through the deterministic CREATE2 factory,
/// or finds the existing deployment, then asserts the onchain state matches
/// the intended configuration (MV-S15). The factory takes the adapter (and,
/// from P2-U2, the Executor) in its constructor (Q-47, D-235).
/// Run it through `pnpm deploy:account-factory`, which refuses anything but
/// the local fork and sets these variables:
///   ACCOUNT_FACTORY_ADMIN, ACCOUNT_FACTORY_GUARDIAN, ACCOUNT_FACTORY_SENTINEL,
///   ACCOUNT_FACTORY_AGENT_NFT, ACCOUNT_FACTORY_USDC, ACCOUNT_FACTORY_WMON,
///   ACCOUNT_FACTORY_PERSONAL_CAP, ACCOUNT_FACTORY_PLATFORM_CAP,
///   ACCOUNT_FACTORY_ALLOWLIST (comma-separated), ORACLE_MON_USD_FEED,
///   ORACLE_USDC_USD_FEED, ORACLE_STATE_VIEW and ORACLE_POOL_ID.
contract DeployAccountFactory is Script {
    bytes32 public constant SALT = keccak256("alpha-agents.account-factory.v1");
    bytes32 public constant ORACLE_SALT = keccak256("alpha-agents.oracle-adapter.v1");

    /// The launch oracle rules (D-151, D-168, FINAL_PLAN 4.1.9, A-34); packages/policy's LAUNCH_LIMITS holds the same.
    uint256 internal constant MON_USD_MAX_AGE = 300;
    uint256 internal constant USDC_USD_MAX_AGE = 3_900;
    uint8 internal constant FEED_DECIMALS = 8;
    uint256 internal constant MAX_DEVIATION_BPS = 200;
    uint256 internal constant MAX_DEPEG_BPS = 100;

    /// The local fork's own chain ID (D-195). Testnet and mainnet are added by
    /// the units that deploy there (PB-U1 for the beta).
    uint256 internal constant LOCAL_FORK_CHAIN_ID = 143143;

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
        require(block.chainid == LOCAL_FORK_CHAIN_ID, "not the local fork (143143)");
        OracleAdapter adapter = _deployOracle();
        // The Executor arrives in P2-U2; until then the factory starts without one.
        address executor = address(0);
        Config memory c = Config({
            admin: vm.envAddress("ACCOUNT_FACTORY_ADMIN"),
            guardian: vm.envAddress("ACCOUNT_FACTORY_GUARDIAN"),
            sentinel: vm.envAddress("ACCOUNT_FACTORY_SENTINEL"),
            oracle: address(adapter),
            executor: executor,
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
        address predicted = vm.computeCreate2Address(SALT, keccak256(initCode), CREATE2_FACTORY);

        bool fresh = predicted.code.length == 0;
        if (!fresh) {
            console.log("AccountFactory already deployed");
            factory = AccountFactory(predicted);
        } else {
            vm.startBroadcast();
            factory = new AccountFactory{salt: SALT}(
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
        console.log("ORACLE_ADAPTER_ADDRESS", address(adapter));
        console.log("ORACLE_ADAPTER_CODE_SIZE", address(adapter).code.length);
        console.log("ACCOUNT_FACTORY_ADDRESS", address(factory));
        console.log("ACCOUNT_FACTORY_CODE_SIZE", address(factory).code.length);
        console.log("PERSONAL_ACCOUNT_IMPLEMENTATION", factory.PERSONAL_ACCOUNT_IMPLEMENTATION());
        console.log("PERSONAL_ACCOUNT_CODE_SIZE", factory.PERSONAL_ACCOUNT_IMPLEMENTATION().code.length);
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
        address predicted = vm.computeCreate2Address(ORACLE_SALT, keccak256(initCode), CREATE2_FACTORY);
        if (predicted.code.length == 0) {
            vm.startBroadcast();
            adapter = new OracleAdapter{salt: ORACLE_SALT}(o);
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
