// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Script, console} from "forge-std/Script.sol";
import {AccountFactoryV3} from "../src/fund/AccountFactoryV3.sol";
import {CustodyCoreV3} from "../src/fund/CustodyCoreV3.sol";
import {PersonalAccountV3} from "../src/fund/PersonalAccountV3.sol";
import {ProtocolRegistryV3} from "../src/fund/ProtocolRegistryV3.sol";
import {RouteAdapter} from "../src/fund/RouteAdapter.sol";
import {TokenRegistry} from "../src/fund/TokenRegistry.sol";
import {Venue} from "../src/interfaces/IFund.sol";

interface IWMONDeposit {
    function deposit() external payable;
}

/// The owner's demo of the custody core v3 (F-U3), run by `pnpm custody:v3:demo`
/// on a fork of its own: an account opened for a real agent, four core tokens
/// deposited (USDC, WMON, cbBTC and shMON, the last two bought through real
/// pools first), the cost-basis record, the screened-lane opt-in, and a
/// withdrawal of everything that reads no price. Throwaway forks only.
contract DemoCustodyV3 is Script {
    address internal constant LV = 0x1001fF13bf368Aa4fa85F21043648079F00E1001;
    address internal constant LV_WMON_CAKE = 0x276664dA3b25aF7Cd13EB4D3294d9840b60E5732;
    address internal constant CBBTC = 0xd18B7EC58Cdf4876f6AFebd3Ed1730e4Ce10414b;
    address internal constant SHMON = 0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c;

    AccountFactoryV3 internal factory;
    TokenRegistry internal tokens;
    ProtocolRegistryV3 internal pools;
    RouteAdapter internal adapter;
    PersonalAccountV3 internal account;
    address internal owner;
    address internal admin;
    address internal screener;
    uint256 internal agentId;
    address internal usdc;
    address internal wmon;

    function run() external {
        require(block.chainid == 143143, "the demo runs only on a local fork");
        factory = AccountFactoryV3(vm.envAddress("ACCOUNT_FACTORY_V3"));
        tokens = TokenRegistry(vm.envAddress("TOKEN_REGISTRY"));
        pools = ProtocolRegistryV3(vm.envAddress("PROTOCOL_REGISTRY_V3"));
        adapter = RouteAdapter(payable(vm.envAddress("ROUTE_ADAPTER")));
        owner = vm.envAddress("DEMO_OWNER");
        admin = vm.envAddress("FUND_ADMIN");
        screener = vm.envAddress("FUND_SCREENER");
        agentId = vm.envUint("DEMO_AGENT_ID");
        usdc = factory.USDC();
        wmon = pools.WMON();

        _open();
        _acquire();
        _deposit();
        _show("== the account after four deposits");
        _optIn();
        _withdraw();
        _show("== the account after withdrawing everything");
    }

    function _open() internal {
        console.log("== the owner opens a PersonalAccountV3 for agent", agentId);
        vm.startBroadcast(owner);
        account = PersonalAccountV3(factory.createPersonalAccount(agentId));
        vm.stopBroadcast();
        console.log("account:", address(account));
        console.log("held tokens at creation (USDC only):", account.heldCount());
    }

    /// cbBTC and shMON for the owner, bought with USDC through the real pools
    /// (the adapter's demo executor is the admin), and WMON by wrapping MON.
    function _acquire() internal {
        console.log("== the owner buys cbBTC and shMON through real pools, and wraps some MON");
        // 20 USDC of each, so the four deposits stay inside the beta's 100 USDC cap.
        vm.startBroadcast(admin);
        IERC20(usdc).transfer(address(adapter), 20e6);
        bytes32[] memory toCbbtc = new bytes32[](2);
        toCbbtc[0] = pools.poolIds(1);
        toCbbtc[1] = pools.poolIds(2);
        uint256 cb = adapter.swapRoute(usdc, CBBTC, 20e6, 1, owner, toCbbtc, false);
        IERC20(usdc).transfer(address(adapter), 20e6);
        bytes32[] memory toShmon = new bytes32[](2);
        toShmon[0] = pools.poolIds(0);
        toShmon[1] = pools.poolIds(3);
        uint256 sh = adapter.swapRoute(usdc, SHMON, 20e6, 1, owner, toShmon, false);
        vm.stopBroadcast();
        console.log("cbBTC to the owner (satoshi):", cb);
        console.log("shMON to the owner (wei):", sh);
        vm.startBroadcast(owner);
        IWMONDeposit(wmon).deposit{value: 20 ether}();
        vm.stopBroadcast();
    }

    function _deposit() internal {
        console.log("== the owner deposits USDC, WMON, cbBTC and shMON");
        address[4] memory list = [usdc, wmon, CBBTC, SHMON];
        vm.startBroadcast(owner);
        for (uint256 i = 0; i < list.length; ++i) {
            uint256 amount = IERC20(list[i]).balanceOf(owner);
            if (list[i] == usdc) amount = 30e6;
            IERC20(list[i]).approve(address(account), amount);
            account.deposit(list[i], amount);
            console.log(string.concat("deposited ", IERC20Metadata(list[i]).symbol(), ": ", vm.toString(amount)));
        }
        vm.stopBroadcast();
    }

    function _show(string memory title) internal view {
        console.log(title);
        CustodyCoreV3.Holding[] memory h = account.holdings();
        for (uint256 i = 0; i < h.length; ++i) {
            console.log(
                string.concat(
                    IERC20Metadata(h[i].token).symbol(),
                    "  balance ",
                    vm.toString(h[i].balance),
                    "  cost basis (USDC e6) ",
                    vm.toString(h[i].costBasis),
                    "  last price (USDC e18) ",
                    vm.toString(h[i].lastPriceE18)
                )
            );
        }
        console.log("held tokens:", h.length);
        console.log("principal (USDC e6):", account.principal());
        console.log("units (e18):", account.units());
        if (account.units() > 0) {
            (uint256 nav, uint256 perUnit,,) = account.breakerState();
            console.log("value (USDC e6):", nav);
            console.log("value per unit (e18):", perUnit);
            (uint256 capped, uint256 totalBasis, uint256 classABasis) = account.capValues();
            console.log("capped value / total basis / class A basis:", capped, totalBasis, classABasis);
        }
    }

    function _optIn() internal {
        console.log("== the screener adds LV to the screened lane; the owner opts in, then out");
        vm.startBroadcast(screener);
        tokens.addScreened(LV, 800, keccak256("demo screen"), uint64(block.timestamp));
        pools.addScreenedPool(ProtocolRegistryV3.PoolSeed(Venue.PANCAKESWAP_V3, LV, wmon, 2_500, 50, LV_WMON_CAKE));
        vm.stopBroadcast();
        console.log("LV buyable for this account before the opt-in:", tokens.buyableFor(LV, address(account)));
        vm.startBroadcast(owner);
        account.setScreenedOptIn(true);
        vm.stopBroadcast();
        console.log("LV buyable after the owner's opt-in:", tokens.buyableFor(LV, address(account)));
        vm.startBroadcast(owner);
        account.setScreenedOptIn(false);
        vm.stopBroadcast();
        console.log("LV buyable after opting out, at once:", tokens.buyableFor(LV, address(account)));
    }

    function _withdraw() internal {
        console.log("== the owner withdraws everything in one call: no price, no oracle, no platform");
        vm.startBroadcast(owner);
        account.withdrawAll(owner);
        vm.stopBroadcast();
        address[4] memory list = [usdc, wmon, CBBTC, SHMON];
        for (uint256 i = 0; i < list.length; ++i) {
            console.log(
                string.concat(
                    "the owner's wallet holds ",
                    IERC20Metadata(list[i]).symbol(),
                    ": ",
                    vm.toString(IERC20(list[i]).balanceOf(owner))
                )
            );
        }
    }
}
