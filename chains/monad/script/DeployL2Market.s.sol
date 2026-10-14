// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AgentCopyNFT} from "../src/AgentCopyNFT.sol";
import {DeployScope} from "./DeployScope.sol";
import {TestUSDC} from "./TestUSDC.sol";

interface IWETH9 {
    function deposit() external payable;
}

interface IChainlinkFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IV3Factory {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

interface IV3PoolState {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
}

interface IPositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

/// CO-U1: the market an L2 testnet needs for one trade to fill: TestUSDC, the agents' copy NFT,
/// and one WETH/tUSDC Uniswap v3 pool (0.05%) created at Chainlink's ETH/USD price, with
/// liquidity in a narrow range around it (L2_POOL_TICK_HALF_WIDTH ticks, 250 = about 2.5%).
/// Reads L2_WETH, L2_ETH_USD_FEED, L2_UNISWAP_V3_FACTORY, L2_POSITION_MANAGER, L2_COPY_MINTER,
/// L2_COPY_IMAGE_BASE_URI, L2_POOL_WETH (wei of ETH wrapped for the pool). Each part is found
/// again on a rerun; liquidity is added only to an empty pool.
contract DeployL2Market is DeployScope {
    uint24 internal constant FEE = 500;
    int24 internal constant SPACING = 10;

    function run() external {
        address deployer = msg.sender;
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (key != 0) deployer = vm.addr(key);
        saltScope();
        address weth = vm.envAddress("L2_WETH");

        TestUSDC usdc = TestUSDC(
            _create2(salt("test-usdc", 1), abi.encodePacked(type(TestUSDC).creationCode, abi.encode(deployer)))
        );
        AgentCopyNFT nft = AgentCopyNFT(
            _create2(
                salt("agent-copy-nft", 1),
                abi.encodePacked(
                    type(AgentCopyNFT).creationCode,
                    abi.encode(deployer, vm.envAddress("L2_COPY_MINTER"), vm.envString("L2_COPY_IMAGE_BASE_URI"))
                )
            )
        );

        (address token0, address token1) = weth < address(usdc) ? (weth, address(usdc)) : (address(usdc), weth);
        IV3Factory factory = IV3Factory(vm.envAddress("L2_UNISWAP_V3_FACTORY"));
        IPositionManager pm = IPositionManager(vm.envAddress("L2_POSITION_MANAGER"));
        address pool = factory.getPool(token0, token1, FEE);
        if (pool == address(0)) {
            uint160 sqrtPriceX96 = _sqrtPriceAtFeed(weth == token0);
            _startBroadcast();
            pool = pm.createAndInitializePoolIfNecessary(token0, token1, FEE, sqrtPriceX96);
            vm.stopBroadcast();
        }
        if (IV3PoolState(pool).liquidity() == 0) {
            (, int24 tick,,,,,) = IV3PoolState(pool).slot0();
            int24 half = int24(int256(vm.envOr("L2_POOL_TICK_HALF_WIDTH", uint256(250))));
            int24 lower = ((tick - half) / SPACING) * SPACING;
            int24 upper = ((tick + half) / SPACING + 1) * SPACING;
            uint256 wethIn = vm.envUint("L2_POOL_WETH");
            uint256 usdcIn = 1_000_000e6;
            _startBroadcast();
            IWETH9(weth).deposit{value: wethIn}();
            usdc.mint(deployer, usdcIn);
            IERC20(weth).approve(address(pm), wethIn);
            IERC20(address(usdc)).approve(address(pm), usdcIn);
            (uint256 a0, uint256 a1) = weth == token0 ? (wethIn, usdcIn) : (usdcIn, wethIn);
            pm.mint(
                IPositionManager.MintParams({
                    token0: token0,
                    token1: token1,
                    fee: FEE,
                    tickLower: lower,
                    tickUpper: upper,
                    amount0Desired: a0,
                    amount1Desired: a1,
                    amount0Min: 0,
                    amount1Min: 0,
                    recipient: deployer,
                    deadline: block.timestamp + 600
                })
            );
            vm.stopBroadcast();
        }
        (uint160 sqrtNow, int24 tickNow,,,,,) = IV3PoolState(pool).slot0();
        console.log("TEST_USDC_ADDRESS", address(usdc));
        console.log("AGENT_COPY_NFT_ADDRESS", address(nft));
        console.log("POOL_ADDRESS", pool);
        console.log("POOL_TOKEN0", token0);
        console.log("POOL_TOKEN1", token1);
        console.log("POOL_LIQUIDITY", uint256(IV3PoolState(pool).liquidity()));
        console.log("POOL_SQRT_PRICE_X96", uint256(sqrtNow));
        console.logInt(tickNow);
    }

    /// sqrt(price) in Q64.96 for WETH (18 decimals) against tUSDC (6) at Chainlink's ETH/USD (8).
    function _sqrtPriceAtFeed(bool wethIsToken0) internal view returns (uint160) {
        (, int256 answer,, uint256 updatedAt,) = IChainlinkFeed(vm.envAddress("L2_ETH_USD_FEED")).latestRoundData();
        require(answer > 0 && block.timestamp - updatedAt < 1 days, "ETH/USD feed unusable");
        uint256 p = uint256(answer);
        // token1 per token0 in raw units: WETH first, p * 1e6 / (1e8 * 1e18); else its inverse.
        uint256 ratioX192 = wethIsToken0 ? Math.mulDiv(p, 1 << 192, 1e20) : Math.mulDiv(1e20, 1 << 192, p);
        return uint160(Math.sqrt(ratioX192));
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
