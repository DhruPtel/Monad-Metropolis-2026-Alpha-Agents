// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

interface IChainlinkFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
}

interface IUniswapV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}

interface IStateView {
    function getLiquidity(bytes32 poolId) external view returns (uint128);
}

interface IERC20Meta {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/**
 * M-FAST: the Base mainnet facts the address book's base environment, the
 * domain's Base tokens and the Base fork deployment rest on, checked on a fork
 * of Base mainnet at the pinned block. Runs under the base profile:
 * `FOUNDRY_PROFILE=base forge test --match-path 'test/base/*'` (pnpm
 * test:base-fork), with BASE_FORK_TEST_RPC_URL as the upstream, else Base's
 * public endpoint. Reads only; nothing is deployed or sent.
 */
contract BaseForkTest is Test {
    uint256 internal constant BASE_CHAIN_ID = 8453;
    uint256 internal constant PINNED_BLOCK = 52_534_000;

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address internal constant ETH_USD_FEED = 0xa4250cE1aA15Ff4cb5E5a8655293b65694e436Ed;
    address internal constant USDC_USD_FEED = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;
    address internal constant UNISWAP_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant UNISWAP_V3_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant UNISWAP_V3_QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;
    address internal constant PANCAKE_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address internal constant V4_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address internal constant V4_STATE_VIEW = 0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71;
    address internal constant V4_QUOTER = 0x0d5e0F971ED27FBfF6c2837bf31316121532048D;
    address internal constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant ERC6551_REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address internal constant TOKENBOUND_V3 = 0x41C8f39463A868d3A88af00cd0fe7102F30E44eC;
    address internal constant PYTH_ENTROPY = 0x6E7D74FA7d5c90FEF9F0512987605a6d546181Bb;
    address internal constant USDC_WETH_500 = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    address internal constant USDC_WETH_3000 = 0x6c561B446416E1A00E8E93E221854d6eA4171372;
    bytes32 internal constant V4_ETH_USDC_500 = 0x96d4b53a38337a5733179751781178a2613306063c511b78cd02684739288c0a;
    /**
     * keccak256 of the deterministic CREATE2 deployer's runtime code, the same as Monad's.
     */
    bytes32 internal constant CREATE2_DEPLOYER_CODEHASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    function setUp() public {
        string memory url = vm.envOr("BASE_FORK_TEST_RPC_URL", string("https://mainnet.base.org"));
        vm.createSelectFork(url, PINNED_BLOCK);
        assertEq(block.chainid, BASE_CHAIN_ID, "not Base mainnet");
    }

    function test_externalContractsHaveCode() public view {
        address[16] memory contracts = [
            USDC,
            WETH,
            CBBTC,
            UNISWAP_V3_FACTORY,
            UNISWAP_V3_ROUTER02,
            UNISWAP_V3_QUOTER_V2,
            PANCAKE_V3_FACTORY,
            V4_POOL_MANAGER,
            V4_STATE_VIEW,
            V4_QUOTER,
            UNIVERSAL_ROUTER,
            PERMIT2,
            ERC6551_REGISTRY,
            TOKENBOUND_V3,
            PYTH_ENTROPY,
            CREATE2_DEPLOYER
        ];
        for (uint256 i = 0; i < contracts.length; i++) {
            assertGt(contracts[i].code.length, 0, "no code");
        }
        assertEq(CREATE2_DEPLOYER.codehash, CREATE2_DEPLOYER_CODEHASH, "CREATE2 deployer differs");
    }

    function test_tokensAnswerAsExpected() public view {
        assertEq(IERC20Meta(USDC).decimals(), 6);
        assertEq(IERC20Meta(USDC).symbol(), "USDC");
        assertEq(IERC20Meta(WETH).decimals(), 18);
        assertEq(IERC20Meta(WETH).symbol(), "WETH");
        assertEq(IERC20Meta(CBBTC).decimals(), 8);
        assertEq(IERC20Meta(CBBTC).symbol(), "cbBTC");
    }

    function test_chainlinkFeedsAreLiveAtThePin() public view {
        (, int256 eth,, uint256 ethUpdated,) = IChainlinkFeed(ETH_USD_FEED).latestRoundData();
        assertEq(IChainlinkFeed(ETH_USD_FEED).decimals(), 8);
        assertEq(IChainlinkFeed(ETH_USD_FEED).description(), "ETH / USD");
        // A sane band, not a price: ETH between 100 and 100,000 USD.
        assertGt(eth, 100e8);
        assertLt(eth, 100_000e8);
        // ETH/USD's heartbeat is 1,200 s; USDC/USD's a day.
        assertLe(block.timestamp - ethUpdated, 1_200 + 300, "ETH/USD stale at the pin");
        (, int256 usdc,, uint256 usdcUpdated,) = IChainlinkFeed(USDC_USD_FEED).latestRoundData();
        assertGt(usdc, 0.95e8);
        assertLt(usdc, 1.05e8);
        assertLe(block.timestamp - usdcUpdated, 86_400 + 3_600, "USDC/USD stale at the pin");
    }

    function test_corePoolsAreTheFactoriesOwn() public view {
        assertEq(IUniswapV3Factory(UNISWAP_V3_FACTORY).getPool(USDC, WETH, 500), USDC_WETH_500);
        assertEq(IUniswapV3Factory(UNISWAP_V3_FACTORY).getPool(USDC, WETH, 3000), USDC_WETH_3000);
        assertEq(IUniswapV3Pool(USDC_WETH_3000).fee(), 3000);
        assertGt(IUniswapV3Pool(USDC_WETH_3000).liquidity(), 0);
        // The v4 ETH/USDC 0.05% pool exists and holds liquidity.
        assertGt(IStateView(V4_STATE_VIEW).getLiquidity(V4_ETH_USDC_500), 0);
    }
}
