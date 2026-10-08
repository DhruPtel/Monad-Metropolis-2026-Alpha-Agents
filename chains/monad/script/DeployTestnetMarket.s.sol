// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "../src/interfaces/IUniswap.sol";
import {DeployScope} from "./DeployScope.sol";
import {IPoolManagerLiquidity, PoolSeeder} from "./PoolSeeder.sol";
import {TestnetFeed} from "./TestnetFeed.sol";

interface IStateViewLiquidity {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);

    function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity);
}

/// P2-EC testnet market (D-253, D-257, D-304, D-307): the two TestnetFeeds,
/// the pool seeder, and the hookless native MON/USDC 0.05% pool (tick spacing
/// 10, Circle's testnet USDC) on the unofficial testnet Uniswap v4, started at
/// the operator price of 1 MON = 1 USDC and seeded once. Every step finds what
/// an earlier run did instead of repeating it. Run through `pnpm deploy:testnet`,
/// which sets:
///   DEPLOYER_PRIVATE_KEY, DEPLOY_SALT_SCOPE=p2ec.testnet, TESTNET_FEED_WRITER,
///   TESTNET_USDC, TESTNET_POOL_MANAGER, TESTNET_STATE_VIEW, SEED_MON_WEI,
///   SEED_USDC_RAW, SEED_LIQUIDITY, SEED_TICK_LOWER and SEED_TICK_UPPER.
contract DeployTestnetMarket is DeployScope {
    uint24 public constant FEE = 500;
    int24 public constant TICK_SPACING = 10;
    uint8 public constant FEED_DECIMALS = 8;
    /// 1.00 USD in 8 decimals: the operator price of MON (D-304) and USDC's peg.
    int256 public constant ONE_USD = 1e8;
    /// sqrt(1e6 / 1e18) * 2^96, floored: 1 MON (18 decimals) = 1 USDC (6 decimals).
    uint160 public constant START_SQRT_PRICE_X96 = 79_228_162_514_264_337_593_543;

    struct Market {
        address monUsdFeed;
        address usdcUsdFeed;
        address seeder;
        bytes32 poolId;
    }

    function run() external returns (Market memory m) {
        require(block.chainid == MONAD_TESTNET_CHAIN_ID, "the testnet market exists only on Monad testnet");
        address deployer = vm.addr(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        address writer = vm.envAddress("TESTNET_FEED_WRITER");
        address usdc = vm.envAddress("TESTNET_USDC");
        address pm = vm.envAddress("TESTNET_POOL_MANAGER");
        IStateViewLiquidity stateView = IStateViewLiquidity(vm.envAddress("TESTNET_STATE_VIEW"));
        require(usdc.code.length > 0 && pm.code.length > 0, "USDC or PoolManager missing");
        require(address(stateView).code.length > 0, "StateView missing");

        m.monUsdFeed = _feed("testnet-feed.mon-usd", writer, "MON / USD (testnet operator price, D-304)");
        m.usdcUsdFeed = _feed("testnet-feed.usdc-usd", writer, "USDC / USD (testnet operator price)");
        m.seeder = _create2(
            salt("pool-seeder"),
            abi.encodePacked(type(PoolSeeder).creationCode, abi.encode(IPoolManagerLiquidity(pm), deployer))
        );
        PoolSeeder seeder = PoolSeeder(payable(m.seeder));
        require(address(seeder.POOL_MANAGER()) == pm && seeder.owner() == deployer, "seeder");

        PoolKey memory key =
            PoolKey({currency0: address(0), currency1: usdc, fee: FEE, tickSpacing: TICK_SPACING, hooks: address(0)});
        m.poolId = keccak256(abi.encode(key));

        (uint160 sqrtPrice,,,) = stateView.getSlot0(m.poolId);
        if (sqrtPrice == 0) {
            _startBroadcast();
            seeder.initialize(key, START_SQRT_PRICE_X96);
            vm.stopBroadcast();
            (sqrtPrice,,,) = stateView.getSlot0(m.poolId);
        }
        require(sqrtPrice != 0, "pool not initialized");

        if (stateView.getLiquidity(m.poolId) == 0) {
            uint256 seedUsdc = vm.envUint("SEED_USDC_RAW");
            uint256 seedMon = vm.envUint("SEED_MON_WEI");
            int24 lower = int24(vm.envInt("SEED_TICK_LOWER"));
            int24 upper = int24(vm.envInt("SEED_TICK_UPPER"));
            uint128 liquidity = uint128(vm.envUint("SEED_LIQUIDITY"));
            _startBroadcast();
            require(IERC20(usdc).transfer(m.seeder, seedUsdc), "USDC transfer");
            seeder.addLiquidity{value: seedMon}(key, lower, upper, liquidity);
            vm.stopBroadcast();
        }
        require(stateView.getLiquidity(m.poolId) != 0, "pool has no liquidity");

        (uint160 sqrtAfter, int24 tick,,) = stateView.getSlot0(m.poolId);
        console.log("TESTNET_FEED_MON_USD_ADDRESS", m.monUsdFeed);
        console.log("TESTNET_FEED_USDC_USD_ADDRESS", m.usdcUsdFeed);
        console.log("POOL_SEEDER_ADDRESS", m.seeder);
        console.log("POOL_ID");
        console.logBytes32(m.poolId);
        console.log("POOL_SQRT_PRICE_X96", uint256(sqrtAfter));
        console.log("POOL_TICK", int256(tick));
        console.log("POOL_LIQUIDITY", uint256(stateView.getLiquidity(m.poolId)));
    }

    function _feed(string memory name, address writer, string memory description) internal returns (address addr) {
        addr = _create2(
            salt(name),
            abi.encodePacked(type(TestnetFeed).creationCode, abi.encode(FEED_DECIMALS, writer, description, ONE_USD))
        );
        TestnetFeed feed = TestnetFeed(addr);
        require(feed.decimals() == FEED_DECIMALS && feed.writer() == writer, "feed settings");
    }

    function _create2(bytes32 salt_, bytes memory initCode) internal returns (address addr) {
        addr = vm.computeCreate2Address(salt_, keccak256(initCode), CREATE2_FACTORY);
        if (addr.code.length != 0) return addr;
        _startBroadcast();
        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(salt_, initCode));
        vm.stopBroadcast();
        require(ok && addr.code.length != 0, "CREATE2 deployment failed");
    }
}
