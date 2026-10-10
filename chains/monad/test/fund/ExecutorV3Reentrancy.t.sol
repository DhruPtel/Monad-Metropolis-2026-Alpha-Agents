// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {ExecutorV3} from "../../src/fund/ExecutorV3.sol";
import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
import {SwapIntentV3} from "../../src/interfaces/IExecutorV3.sol";
import {Venue} from "../../src/interfaces/IFund.sol";
import {PoolKey} from "../../src/interfaces/IUniswap.sol";
import {OwnerWallet, ReentrantToken} from "../mocks/CustodyMocks.sol";
import {ExecutorV3Base} from "./ExecutorV3Base.sol";

/// A hostile token inside a trade (F-U4): one the screener listed, whose
/// transfer calls back into the owner's wallet mid-swap. Whatever the wallet
/// then tries, the Executor and the account refuse it, and the trade itself
/// completes exactly as an honest one would.
contract ExecutorV3ReentrancyTest is ExecutorV3Base {
    ReentrantToken internal hostile;
    OwnerWallet internal wallet;
    bytes32 internal idUsdcHostile;

    function _makeOwner() internal override returns (address) {
        wallet = new OwnerWallet();
        return address(wallet);
    }

    function setUp() public override {
        super.setUp();
        setAttestor();
        optIn();
        // The hostile token: class A in the screened lane at 1 USDC, 6 decimals, with a v4 pool against USDC at par.
        hostile = new ReentrantToken();
        vm.prank(SCREENER);
        tokens.addScreened(address(hostile), 1_500, keccak256("hostile"), uint64(block.timestamp));
        refPrice[address(hostile)] = 1e18;
        (address h0, address h1) = _sorted(address(usdc), address(hostile));
        PoolKey memory key = PoolKey(h0, h1, 500, 10, address(0));
        idUsdcHostile = keccak256(abi.encode(key));
        manager.setPrice(key, 1, 1);
        stateView.setSqrt(idUsdcHostile, _sqrtX96(1, 1));
        hostile.mint(address(manager), 1e15);
        vm.prank(SCREENER);
        pools.addScreenedPool(ProtocolRegistryV3.PoolSeed(Venue.UNISWAP_V4, h0, h1, 500, 10, address(0)));
    }

    /// A buy of the hostile token: its first transfer (the pool paying the account) fires the hook.
    function hostileBuy() internal returns (SwapIntentV3 memory i) {
        i = intentWith(
            address(usdc),
            address(hostile),
            10e6,
            floorFor(address(usdc), address(hostile), 10e6),
            _route(idUsdcHostile)
        );
        attest(i);
    }

    function assertHookRefused(bytes4 selector) internal view {
        assertFalse(hostile.lastCallSucceeded(), "the hook's call went through");
        assertEq(bytes4(hostile.lastRevert()), selector);
    }

    function test_AHostileTokenCannotReenterTheExecutorsSwap() public {
        SwapIntentV3 memory inner = hostileBuy();
        hostile.arm(wallet, address(executor), abi.encodeCall(ExecutorV3.swap, (inner)));
        assertEq(submit(hostileBuy()), 10e6);
        assertHookRefused(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(bal(address(hostile), address(account)), 10e6);
        assertNothingKept();
    }

    function test_AHostileTokenCannotMakeTheOwnerWithdrawMidSwap() public {
        hostile.arm(
            wallet, address(account), abi.encodeCall(CustodyCoreV3.withdraw, (address(usdc), 1e6, address(wallet)))
        );
        assertEq(submit(hostileBuy()), 10e6);
        assertHookRefused(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(usdcOf(address(account)), 690e6);
    }

    function test_AHostileTokenCannotCallOnSwapOrExecuteSwap() public {
        SwapParamsV3 memory p;
        hostile.arm(wallet, address(executor), abi.encodeCall(ExecutorV3.onSwap, (p)));
        submit(hostileBuy());
        assertHookRefused(ExecutorV3.NotInSwap.selector);
        hostile.arm(wallet, address(account), abi.encodeCall(CustodyCoreV3.executeSwap, (p)));
        submit(hostileBuy());
        assertHookRefused(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }

    function test_AHostileTokenCannotPullForSwapAgain() public {
        hostile.arm(wallet, address(account), abi.encodeCall(CustodyCoreV3.pullForSwap, (address(usdc), 10e6)));
        submit(hostileBuy());
        assertHookRefused(CustodyCoreV3.SwapContextInvalid.selector);
        assertEq(usdcOf(address(account)), 690e6, "exactly one trade's input left");
    }
}
