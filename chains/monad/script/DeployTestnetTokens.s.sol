// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "../src/interfaces/IUniswap.sol";
import {DeployScope} from "./DeployScope.sol";
import {IStateViewLiquidity} from "./DeployTestnetMarket.s.sol";
import {IPoolManagerLiquidity, PoolSeeder} from "./PoolSeeder.sol";
import {TestnetFeed} from "./TestnetFeed.sol";
import {TestnetToken} from "./TestnetToken.sol";

/// F-U13's two more testnet tokens (BUILD_PLAN 4.0: "seeded pools for
/// USDC/WMON and two more tokens"): two TestnetTokens with 18 decimals, a
/// TestnetFeed for each at the operator price of 1.00 USD, and a hookless
/// native MON / token 0.05% pool for each on the unofficial testnet Uniswap
/// v4, started at 1 MON = 1 token and seeded once through the P2-EC
/// PoolSeeder (native MON is currency0 of every pool it seeds). Every step
/// finds what an earlier run did instead of repeating it. Run through
/// `pnpm deploy:testnet:v3`, which sets:
///   DEPLOYER_PRIVATE_KEY, DEPLOY_SALT_SCOPE=p2ec.testnet, TESTNET_FEED_WRITER,
///   TESTNET_POOL_MANAGER, TESTNET_STATE_VIEW, POOL_SEEDER (the P2-EC seeder),
///   TOKEN_SEED_MON_WEI, TOKEN_SEED_TOKEN_WEI, TOKEN_SEED_LIQUIDITY,
///   TOKEN_SEED_TICK_LOWER and TOKEN_SEED_TICK_UPPER.
contract DeployTestnetTokens is DeployScope {
    uint24 public constant FEE = 500;
    int24 public constant TICK_SPACING = 10;
    uint8 public constant FEED_DECIMALS = 8;
    int256 public constant ONE_USD = 1e8;
    /// 1 MON (18 decimals) = 1 token (18 decimals): sqrt(1) * 2^96.
    uint160 public constant START_SQRT_PRICE_X96 = 79_228_162_514_264_337_593_543_950_336;
    uint256 public constant SUPPLY = 1_000_000 ether;

    struct Token {
        address token;
        address feed;
        bytes32 poolId;
    }

    struct Tokens {
        Token alpha;
        Token beta;
    }

    function run() external returns (Tokens memory t) {
        require(block.chainid == MONAD_TESTNET_CHAIN_ID, "the testnet tokens exist only on Monad testnet");
        address deployer = vm.addr(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        address writer = vm.envAddress("TESTNET_FEED_WRITER");
        address pm = vm.envAddress("TESTNET_POOL_MANAGER");
        IStateViewLiquidity stateView = IStateViewLiquidity(vm.envAddress("TESTNET_STATE_VIEW"));
        PoolSeeder seeder = PoolSeeder(payable(vm.envAddress("POOL_SEEDER")));
        require(pm.code.length > 0 && address(stateView).code.length > 0, "PoolManager or StateView missing");
        require(address(seeder).code.length > 0 && seeder.owner() == deployer, "the pool seeder is not the deployer's");
        require(address(seeder.POOL_MANAGER()) == pm, "the seeder is on another PoolManager");

        t.alpha = _token("testnet-token.alpha", "Testnet Alpha", "TALPHA", writer, deployer, stateView, seeder);
        t.beta = _token("testnet-token.beta", "Testnet Beta", "TBETA", writer, deployer, stateView, seeder);

        console.log("TESTNET_TOKEN_ALPHA_ADDRESS", t.alpha.token);
        console.log("TESTNET_FEED_ALPHA_USD_ADDRESS", t.alpha.feed);
        console.log("TESTNET_POOL_ALPHA_ID");
        console.logBytes32(t.alpha.poolId);
        console.log("TESTNET_TOKEN_BETA_ADDRESS", t.beta.token);
        console.log("TESTNET_FEED_BETA_USD_ADDRESS", t.beta.feed);
        console.log("TESTNET_POOL_BETA_ID");
        console.logBytes32(t.beta.poolId);
        console.log("TESTNET_POOL_ALPHA_LIQUIDITY", uint256(stateView.getLiquidity(t.alpha.poolId)));
        console.log("TESTNET_POOL_BETA_LIQUIDITY", uint256(stateView.getLiquidity(t.beta.poolId)));
    }

    function _token(
        string memory name,
        string memory tokenName,
        string memory symbol,
        address writer,
        address deployer,
        IStateViewLiquidity stateView,
        PoolSeeder seeder
    ) internal returns (Token memory out) {
        out.token = _create2(
            salt(name),
            abi.encodePacked(type(TestnetToken).creationCode, abi.encode(tokenName, symbol, uint8(18), SUPPLY, deployer))
        );
        out.feed = _create2(
            salt(string.concat(name, ".feed")),
            abi.encodePacked(
                type(TestnetFeed).creationCode,
                abi.encode(FEED_DECIMALS, writer, string.concat(symbol, " / USD (testnet operator price)"), ONE_USD)
            )
        );
        PoolKey memory key =
            PoolKey({currency0: address(0), currency1: out.token, fee: FEE, tickSpacing: TICK_SPACING, hooks: address(0)});
        out.poolId = keccak256(abi.encode(key));
        (uint160 sqrtPrice,,,) = stateView.getSlot0(out.poolId);
        if (sqrtPrice == 0) {
            _startBroadcast();
            seeder.initialize(key, START_SQRT_PRICE_X96);
            vm.stopBroadcast();
            (sqrtPrice,,,) = stateView.getSlot0(out.poolId);
        }
        require(sqrtPrice != 0, "pool not initialized");
        if (stateView.getLiquidity(out.poolId) == 0) {
            uint256 seedToken = vm.envUint("TOKEN_SEED_TOKEN_WEI");
            uint256 seedMon = vm.envUint("TOKEN_SEED_MON_WEI");
            int24 lower = int24(vm.envInt("TOKEN_SEED_TICK_LOWER"));
            int24 upper = int24(vm.envInt("TOKEN_SEED_TICK_UPPER"));
            uint128 liquidity = uint128(vm.envUint("TOKEN_SEED_LIQUIDITY"));
            _startBroadcast();
            require(IERC20(out.token).transfer(address(seeder), seedToken), "token transfer");
            seeder.addLiquidity{value: seedMon}(key, lower, upper, liquidity);
            vm.stopBroadcast();
        }
        require(stateView.getLiquidity(out.poolId) != 0, "pool has no liquidity");
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
