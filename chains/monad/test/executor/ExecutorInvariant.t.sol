// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PersonalAccount} from "../../src/custody/PersonalAccount.sol";
import {Executor} from "../../src/executor/Executor.sol";
import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";
import {SwapIntent} from "../../src/interfaces/IExecutor.sol";
import {MockAgentNFT, MockToken} from "../mocks/CustodyMocks.sol";
import {MockVenue} from "../mocks/ExecutorMocks.sol";
import {ExecutorBase} from "./ExecutorBase.sol";

/// Drives the trading stack with random intents from random senders, random
/// venue behaviour, time and price moves, the owner's flows, mode changes and
/// agent transfers, and records what every successful trade did.
contract ExecutorHandler is Test {
    ExecutorInvariantTest internal t;
    Executor internal executor;
    PersonalAccount internal account;
    MockToken internal usdc;
    MockToken internal wmon;
    MockVenue internal venue;
    MockAgentNFT internal nft;
    OracleAdapter internal oracle;
    address internal owner;
    address internal session;
    address internal sentinel;
    uint256 internal agent;

    /// What the account's balances must be, from flows and measured trades.
    int256 public expectedUsdc;
    int256 public expectedWmon;
    uint256 public trades;
    uint256 public refused;
    bytes public lastRefusal;
    bool public violated;
    string public violation;
    uint256 internal counter;
    uint256 internal priceE18 = 1e18;

    struct Done {
        uint256 at;
        uint256 value;
    }

    Done[] internal done;

    constructor(
        ExecutorInvariantTest base,
        Executor e,
        PersonalAccount a,
        MockToken u,
        MockToken w,
        MockVenue v,
        MockAgentNFT n
    ) {
        t = base;
        executor = e;
        account = a;
        usdc = u;
        wmon = w;
        venue = v;
        nft = n;
        owner = account.owner();
        agent = account.agentId();
        session = makeAddr("session key");
        sentinel = makeAddr("sentinel");
        oracle = OracleAdapter(address(executor.factory().oracle()));
        expectedUsdc = int256(usdc.balanceOf(address(account)));
        expectedWmon = int256(wmon.balanceOf(address(account)));
    }

    function _fail(string memory why) internal {
        if (!violated) {
            violated = true;
            violation = why;
        }
    }

    struct Attempt {
        bool intoUsdc;
        address tokenIn;
        address tokenOut;
        uint256 px;
        uint256 nav;
        uint256 amountIn;
        uint256 value;
        uint256 floor;
        uint256 minOut;
        uint256 inBefore;
        uint256 outBefore;
        address from;
    }

    function trade(uint256 seed, bool intoUsdc, uint256 sizeBps, uint256 slipBps, uint8 behaviour, uint8 sender)
        external
    {
        Attempt memory a;
        a.intoUsdc = intoUsdc;
        a.px = oracle.priceE18(address(wmon));
        (a.nav,,,) = account.breakerState();
        a.tokenIn = intoUsdc ? address(wmon) : address(usdc);
        a.tokenOut = intoUsdc ? address(usdc) : address(wmon);
        // Half the trades are small, so runs reach the 20-trade window before the turnover cap.
        uint256 v = a.nav * bound(sizeBps, 1, seed % 2 == 0 ? 100 : 1_500) / 10_000;
        a.amountIn = intoUsdc ? v * 1e30 / a.px : v;
        if (a.amountIn == 0) return;
        // The value as the Executor computes it.
        a.value = intoUsdc ? a.amountIn * a.px / 1e30 : a.amountIn;
        a.floor = executor.oracleFloor(a.tokenIn, a.tokenOut, a.amountIn, a.px, 50);
        // The floor three times in four; one unit under it otherwise, which must be refused.
        a.minOut = slipBps % 4 == 0 && a.floor > 1 ? a.floor - 1 : a.floor;
        // A misbehaving venue about one call in eight.
        venue.setBehaviour(MockVenue.Behaviour(behaviour % 64 < 8 ? behaviour % 8 : 0), "");
        venue.setOutputBps(9_950 + seed % 100);
        a.from = sender % 5 == 0 ? owner : sender % 7 == 0 ? makeAddr("stranger") : session;
        a.inBefore = MockToken(a.tokenIn).balanceOf(address(account));
        a.outBefore = MockToken(a.tokenOut).balanceOf(address(account));
        SwapIntent memory i = _intent(a);
        vm.prank(a.from);
        try executor.swap(i) returns (uint256) {
            _record(a);
        } catch (bytes memory why) {
            ++refused;
            lastRefusal = why;
            emit log_bytes(why);
        }
        venue.setBehaviour(MockVenue.Behaviour.Honest, "");
    }

    function _intent(Attempt memory a) internal returns (SwapIntent memory) {
        return SwapIntent({
            schemaVersion: 1,
            chainId: block.chainid,
            agentId: agent,
            account: address(account),
            actionId: keccak256(abi.encode("h", ++counter)),
            ownerEpoch: nft.ownerEpoch(agent),
            configEpoch: executor.configEpochOf(agent),
            policyHash: executor.policyHash(),
            adapterId: keccak256("mock venue"),
            tokenIn: a.tokenIn,
            tokenOut: a.tokenOut,
            amountIn: a.amountIn,
            minAmountOut: a.minOut,
            deadline: uint64(block.timestamp + 120)
        });
    }

    function _record(Attempt memory a) internal {
        uint256 inAfter = MockToken(a.tokenIn).balanceOf(address(account));
        uint256 outAfter = MockToken(a.tokenOut).balanceOf(address(account));
        if (a.from != session) _fail("a trade from someone other than the session key");
        if (a.inBefore - inAfter > a.amountIn) _fail("more than amountIn left the account");
        if (outAfter - a.outBefore < a.minOut) _fail("less than minAmountOut arrived");
        if (a.value * 10_000 > a.nav * 1_000) _fail("a trade above 10% of value");
        if (a.minOut < a.floor) _fail("a minimum below the oracle floor");
        _checkPost(a.intoUsdc, a.px);
        _checkWindow(a.value, a.nav);
        int256 dIn = int256(inAfter) - int256(a.inBefore);
        int256 dOut = int256(outAfter) - int256(a.outBefore);
        if (a.intoUsdc) {
            expectedWmon += dIn;
            expectedUsdc += dOut;
        } else {
            expectedUsdc += dIn;
            expectedWmon += dOut;
        }
        done.push(Done(block.timestamp, a.value));
        ++trades;
    }

    function _checkPost(bool intoUsdc, uint256 px) internal {
        if (intoUsdc) return;
        uint256 u = account.freeBalance(address(usdc));
        uint256 w = account.freeBalance(address(wmon)) * px / 1e30;
        if (w * 10_000 > (u + w) * 4_000) _fail("over 40% WMON after a buy");
    }

    function _checkWindow(uint256 value, uint256 nav) internal {
        uint256 count;
        uint256 turnover = value;
        for (uint256 k = 0; k < done.length; ++k) {
            if (done[k].at + 86_400 > block.timestamp) {
                ++count;
                turnover += done[k].value;
            }
        }
        if (count >= 20) _fail("a 21st trade in 24 hours");
        if (turnover > nav) _fail("turnover above 100% of value");
    }

    function wait(uint256 secs, uint256 move) external {
        vm.warp(block.timestamp + bound(secs, 0, 2 hours));
        priceE18 = priceE18 * bound(move, 9_500, 10_500) / 10_000;
        if (priceE18 < 1e16) priceE18 = 1e16;
        t.moveMon(int256(priceE18 / 1e10));
        if (block.timestamp + 1 hours > executor.sessionOf(agent).validUntil) {
            vm.prank(account.owner());
            try executor.registerSession(agent, session, uint64(block.timestamp + 7 days)) {} catch {}
        }
    }

    function flow(bool deposit, bool isUsdc, uint256 amount) external {
        MockToken tok = isUsdc ? usdc : wmon;
        amount = bound(amount, 1, isUsdc ? 20e6 : 20e18);
        if (deposit) {
            tok.mint(owner, amount);
            vm.startPrank(owner);
            tok.approve(address(account), amount);
            try account.deposit(address(tok), amount) {
                if (isUsdc) expectedUsdc += int256(amount);
                else expectedWmon += int256(amount);
            } catch {}
            vm.stopPrank();
        } else {
            uint256 held = tok.balanceOf(address(account));
            if (held == 0) return;
            amount = bound(amount, 1, held);
            vm.prank(owner);
            account.withdraw(address(tok), amount, owner);
            if (isUsdc) expectedUsdc -= int256(amount);
            else expectedWmon -= int256(amount);
        }
    }

    function modes(uint8 which) external {
        if (which % 4 == 0) {
            vm.prank(sentinel);
            account.setReduceOnly();
        } else if (which % 4 == 1) {
            vm.prank(sentinel);
            account.pause();
        } else {
            vm.prank(owner);
            account.unpause();
        }
    }

    /// A sale of the agent and its return: the epochs move, the old grant dies.
    function transferAndBack() external {
        nft.setOwner(agent, makeAddr("buyer"));
        nft.setOwner(agent, owner);
        vm.prank(owner);
        executor.registerSession(agent, session, uint64(block.timestamp + 7 days));
    }
}

contract ExecutorInvariantTest is ExecutorBase {
    ExecutorHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new ExecutorHandler(this, executor, account, usdc, wmon, venue, nft);
        // Trades weighted four to one, so runs reach the 20-trade window.
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = ExecutorHandler.trade.selector;
        selectors[1] = ExecutorHandler.trade.selector;
        selectors[2] = ExecutorHandler.trade.selector;
        selectors[3] = ExecutorHandler.trade.selector;
        selectors[4] = ExecutorHandler.wait.selector;
        selectors[5] = ExecutorHandler.flow.selector;
        selectors[6] = ExecutorHandler.modes.selector;
        selectors[7] = ExecutorHandler.transferAndBack.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// The handler moves MON for the whole stack.
    function moveMon(int256 answer) external {
        setMon(answer);
    }

    /// Funds left the account only through the owner's withdrawals and the
    /// measured inputs of trades, and arrived only from deposits and outputs.
    function invariant_TheAccountHoldsExactlyItsFlowsAndTrades() public view {
        assertEq(int256(usdcOf(address(account))), handler.expectedUsdc(), "USDC");
        assertEq(int256(wmonOf(address(account))), handler.expectedWmon(), "WMON");
    }

    function invariant_TheExecutorAndVenueKeepNothingAndNoAllowanceIsLeft() public view {
        assertEq(usdcOf(address(executor)) + wmonOf(address(executor)), 0);
        assertEq(usdcOf(address(venue)) + wmonOf(address(venue)), 0);
        assertEq(usdc.allowance(address(account), address(venue)), 0);
        assertEq(wmon.allowance(address(account), address(venue)), 0);
        assertEq(usdc.allowance(address(executor), address(venue)), 0);
        assertEq(wmon.allowance(address(executor), address(venue)), 0);
    }

    function invariant_EveryTradeObeyedEveryLimit() public view {
        assertFalse(handler.violated(), handler.violation());
    }

    /// The runs reach real trades and real refusals (L-102: not a vacuous probe).
    function test_TheHandlerTradesAndIsRefused() public {
        for (uint256 k = 0; k < 30; ++k) {
            handler.trade(k, k % 2 == 0, 150 * (k % 5 + 1), 1 + k * 4, uint8(k % 9 == 0 ? 1 : 0), 1);
            handler.wait(30 minutes, 10_000);
        }
        handler.trade(0, true, 900, 10_000, 1, 1); // a venue paying elsewhere: refused
        assertGe(handler.trades(), 15);
        assertGt(handler.refused(), 1);
        invariant_TheAccountHoldsExactlyItsFlowsAndTrades();
        invariant_EveryTradeObeyedEveryLimit();
    }
}
