// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {IPoolRegistry} from "../../src/interfaces/IFund.sol";
import {IPoolManager} from "../../src/interfaces/IUniswap.sol";
import {RouteAdapter} from "../../src/fund/RouteAdapter.sol";
import {MockToken} from "../mocks/CustodyMocks.sol";
import {MockWMON} from "../mocks/FundMocks.sol";
import {FundBase} from "./FundBase.sol";

/// The Executor's side of the invariant: random routes, random amounts, and
/// strangers donating dust to the adapter.
contract RouteHandler is Test {
    RouteAdapter public immutable adapter;
    address public immutable account;
    address[] public tokensIn;
    address[] public tokensOut;
    bytes32[][] internal routes;
    MockWMON internal wmon;
    mapping(address => uint256) public donated;
    uint256 public swaps;

    constructor(RouteAdapter adapter_, address account_, MockWMON wmon_) {
        adapter = adapter_;
        account = account_;
        wmon = wmon_;
    }

    function addRoute(address tin, address tout, bytes32[] memory r) external {
        tokensIn.push(tin);
        tokensOut.push(tout);
        routes.push(r);
    }

    function swap(uint256 which, uint256 amount) external {
        which = bound(which, 0, routes.length - 1);
        amount = bound(amount, 1e6, 1e22);
        address tin = tokensIn[which];
        if (tin == address(wmon)) {
            vm.deal(address(this), amount);
            wmon.deposit{value: amount}();
        } else {
            MockToken(tin).mint(address(this), amount);
        }
        IERC20(tin).transfer(address(adapter), amount);
        adapter.swapRoute(tin, tokensOut[which], amount, 0, account, routes[which], false);
        swaps++;
    }

    function donate(uint256 which, uint256 amount) external {
        which = bound(which, 0, tokensIn.length - 1);
        amount = bound(amount, 1, 1e9);
        address t = tokensIn[which];
        if (t == address(wmon)) return;
        MockToken(t).mint(address(adapter), amount);
        donated[t] += amount;
    }

    receive() external payable {}
}

/// No route ever leaves funds in the adapter or sends them anywhere but the
/// account (F-U2): whatever the adapter holds is exactly what strangers gave it.
contract RouteInvariantTest is FundBase {
    RouteHandler internal handler;
    RouteAdapter internal routed;
    address internal constant ACCOUNT = address(0xACC7);

    function setUp() public override {
        super.setUp();
        // The handler is this adapter's Executor: predict its address, then deploy both.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        routed = new RouteAdapter(
            IPoolRegistry(address(pools)), IPoolManager(address(manager)), address(wmon), address(usdc), predicted
        );
        handler = new RouteHandler(routed, ACCOUNT, wmon);
        assertEq(address(handler), predicted);
        handler.addRoute(address(wmon), address(usdc), _route(idUsdcWmon));
        handler.addRoute(address(tokA), address(usdc), _route(idAWmon, idUsdcWmon));
        handler.addRoute(address(tokC), address(usdc), _route(idMonC, idUsdcWmon));
        handler.addRoute(address(tokA), address(tokB), _route(idAWmon, idUsdcWmon, idBUsdc));
        handler.addRoute(address(usdc), address(tokC), _route(idUsdcWmon, idMonC));
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = RouteHandler.swap.selector;
        selectors[1] = RouteHandler.donate.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    function invariant_TheAdapterHoldsOnlyWhatStrangersGaveIt() public view {
        address[5] memory all = [address(usdc), address(wmon), address(tokA), address(tokB), address(tokC)];
        for (uint256 i = 0; i < all.length; ++i) {
            assertEq(IERC20(all[i]).balanceOf(address(routed)), handler.donated(all[i]));
        }
        assertEq(address(routed).balance, 0);
    }

    function invariant_TheHandlerKeepsNothingAfterASwap() public view {
        // The Executor sends exactly the input; nothing comes back to it.
        address[5] memory all = [address(usdc), address(wmon), address(tokA), address(tokB), address(tokC)];
        for (uint256 i = 0; i < all.length; ++i) {
            assertEq(IERC20(all[i]).balanceOf(address(handler)), 0);
        }
    }
}
