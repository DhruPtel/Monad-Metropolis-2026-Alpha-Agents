// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Script, console} from "forge-std/Script.sol";
import {Lane, PriceClass, TokenRecord, TokenStatus, Venue} from "../src/interfaces/IFund.sol";
import {ProtocolRegistryV3} from "../src/fund/ProtocolRegistryV3.sol";
import {RouteAdapter} from "../src/fund/RouteAdapter.sol";
import {TokenRegistry} from "../src/fund/TokenRegistry.sol";

/// The owner's demo of the v3 set (F-U2), run by `pnpm fund:demo` on a fork of
/// its own: the registry's tokens and lanes, a screened token added at once, a
/// single-hop and a two-hop swap through real pools, and a sell-only switch
/// that is instant while restoring waits the timelock. Throwaway forks only.
contract DemoFund is Script {
    address internal constant LV = 0x1001fF13bf368Aa4fa85F21043648079F00E1001;
    address internal constant LV_WMON_CAKE = 0x276664dA3b25aF7Cd13EB4D3294d9840b60E5732;
    address internal constant CBBTC = 0xd18B7EC58Cdf4876f6AFebd3Ed1730e4Ce10414b;
    address internal constant WBTC = 0x0555E30da8f98308EdB960aa94C0Db47230d2B9c;

    TokenRegistry internal tokens;
    ProtocolRegistryV3 internal pools;
    RouteAdapter internal adapter;
    address internal admin;
    address internal screener;
    address internal account;

    function run() external {
        require(block.chainid == 143143, "the demo runs only on a local fork");
        tokens = TokenRegistry(vm.envAddress("TOKEN_REGISTRY"));
        pools = ProtocolRegistryV3(vm.envAddress("PROTOCOL_REGISTRY_V3"));
        adapter = RouteAdapter(payable(vm.envAddress("ROUTE_ADAPTER")));
        admin = vm.envAddress("FUND_ADMIN");
        screener = vm.envAddress("FUND_SCREENER");
        account = vm.envAddress("FUND_DEMO_ACCOUNT");
        console.log("== the registry's tokens");
        _list(tokens);
        _screened();
        _swaps();
        _sellOnly();
    }

    function _screened() internal {
        console.log("== the screener adds LV to the screened lane at once, with its PancakeSwap pool");
        vm.startBroadcast(screener);
        tokens.addScreened(LV, 800, keccak256("demo screen"), uint64(block.timestamp));
        bytes32 lvPool = pools.addScreenedPool(
            ProtocolRegistryV3.PoolSeed(Venue.PANCAKESWAP_V3, LV, pools.WMON(), 2_500, 50, LV_WMON_CAKE)
        );
        vm.stopBroadcast();
        TokenRecord memory lv = tokens.tokenRecord(LV);
        console.log("LV lane (1 core, 2 screened):", uint256(lv.lane));
        console.log("LV class (1 F, 2 A):", uint256(lv.priceClass));
        console.log("LV buyable by an account that has not opted in:", tokens.buyableFor(LV, account));
        console.log("screened pool id:");
        console.logBytes32(lvPool);
    }

    function _swap(address tokenIn, address tokenOut, bytes32[] memory route) internal returns (uint256 out) {
        vm.startBroadcast(admin);
        IERC20(tokenIn).transfer(address(adapter), 100e6);
        out = adapter.swapRoute(tokenIn, tokenOut, 100e6, 1, account, route, false);
        vm.stopBroadcast();
    }

    function _swaps() internal {
        address usdc = pools.USDC();
        address wmon = pools.WMON();
        console.log("== a single-hop swap: 100 USDC to WMON on Uniswap v3");
        bytes32[] memory one = new bytes32[](1);
        one[0] = pools.poolIds(0);
        console.log("WMON to the account (wei):", _swap(usdc, wmon, one));
        console.log("== a two-hop swap: 100 USDC to WMON to cbBTC, both on PancakeSwap v3");
        bytes32[] memory two = new bytes32[](2);
        two[0] = pools.poolIds(1);
        two[1] = pools.poolIds(2);
        console.log("cbBTC to the account (satoshi):", _swap(usdc, CBBTC, two));
        console.log("the adapter keeps USDC:", IERC20(usdc).balanceOf(address(adapter)));
        console.log("the adapter keeps WMON:", IERC20(wmon).balanceOf(address(adapter)));
    }

    function _sellOnly() internal {
        console.log("== WBTC switched to sell-only by the screener, at once");
        console.log("WBTC buyable before:", tokens.buyableFor(WBTC, account));
        vm.startBroadcast(screener);
        tokens.setSellOnly(WBTC);
        vm.stopBroadcast();
        console.log("WBTC buyable after:", tokens.buyableFor(WBTC, account));
        console.log("WBTC sellable after:", tokens.sellable(WBTC));
        uint8 restore = tokens.RESTORE();
        vm.startBroadcast(admin);
        bytes32 id = tokens.propose(restore, abi.encode(WBTC, TokenStatus.BUYABLE));
        vm.stopBroadcast();
        (uint64 executableAt,) = tokens.pending(id);
        console.log("restoring it is only a proposal, executable in seconds:", executableAt - block.timestamp);
    }

    function _list(TokenRegistry tokens) internal view {
        for (uint256 i = 0; i < tokens.tokenCount(); ++i) {
            address t = tokens.tokens(i);
            TokenRecord memory r = tokens.tokenRecord(t);
            console.log(
                string.concat(
                    IERC20Metadata(t).symbol(),
                    r.lane == Lane.CORE ? "  core" : "  screened",
                    r.priceClass == PriceClass.F ? "  class F" : "  class A",
                    r.status == TokenStatus.BUYABLE ? "  buyable" : "  restricted",
                    "  cap bps ",
                    vm.toString(r.maxPositionBps)
                )
            );
        }
    }
}
