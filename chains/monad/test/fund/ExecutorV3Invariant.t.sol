// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {ExecutorV3} from "../../src/fund/ExecutorV3.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {SwapIntentV3} from "../../src/interfaces/IExecutorV3.sol";
import {PriceReason} from "../../src/interfaces/IFund.sol";
import {MockAgentNFT} from "../mocks/CustodyMocks.sol";
import {MockRouteAdapter} from "../mocks/ExecutorV3Mocks.sol";
import {ExecutorV3Base} from "./ExecutorV3Base.sol";

/// Drives the fund trading stack with random intents over four class F tokens
/// and every route between them, from random senders, through the real
/// RouteAdapter or a venue that misbehaves one call in eight, with time and
/// MON price moves, the owner's flows, mode changes and agent transfers, and
/// records what every successful trade did.
contract ExecutorV3Handler is Test {
    ExecutorV3InvariantTest internal t;
    ExecutorV3 internal executor;
    PersonalAccountV3 internal account;
    MockRouteAdapter internal venue;
    MockAgentNFT internal nft;
    OracleAdapterV3 internal oracle;
    address[4] internal toks;
    address internal usdc;
    address internal owner;
    address internal session;
    address internal sentinel;
    address internal guardian;
    address internal stranger = makeAddr("stranger");
    uint256 internal agent;

    /// What the account's balance of each token must be, from flows and measured trades.
    mapping(address => int256) public expected;
    uint256 public trades;
    uint256 public refused;
    uint256 public skipped;
    bool public violated;
    string public violation;
    uint256 internal counter;
    int256 internal monAnswer = 2e8;

    struct Done {
        uint256 at;
        uint256 value;
    }

    Done[] internal done;

    constructor(
        ExecutorV3InvariantTest base,
        ExecutorV3 e,
        PersonalAccountV3 a,
        MockRouteAdapter v,
        MockAgentNFT n,
        address[4] memory tokens_,
        address sentinel_,
        address guardian_
    ) {
        t = base;
        executor = e;
        account = a;
        venue = v;
        nft = n;
        toks = tokens_;
        usdc = tokens_[0];
        sentinel = sentinel_;
        guardian = guardian_;
        owner = account.owner();
        agent = account.agentId();
        session = makeAddr("session key");
        oracle = OracleAdapterV3(address(executor.factory().oracle()));
        for (uint256 k = 0; k < 4; ++k) {
            expected[toks[k]] = int256(IERC20(toks[k]).balanceOf(address(account)));
        }
    }

    function _fail(string memory why) internal {
        if (!violated) {
            violated = true;
            violation = why;
        }
    }

    struct Attempt {
        address tokenIn;
        address tokenOut;
        uint256 pxIn;
        uint256 pxOut;
        uint8 decIn;
        uint8 decOut;
        uint256 capped;
        uint256 amountIn;
        uint256 value;
        uint256 floor;
        uint256 minOut;
        uint256 inBefore;
        uint256 outBefore;
        address from;
    }

    function trade(uint256 seed, uint8 pair, uint256 sizeBps, uint256 slip, uint8 behaviour, uint8 sender) external {
        Attempt memory a;
        a.tokenIn = toks[pair % 4];
        a.tokenOut = toks[(pair / 4) % 4];
        if (a.tokenIn == a.tokenOut) a.tokenOut = toks[(pair / 4 + 1) % 4];
        PriceReason r1;
        PriceReason r2;
        (a.pxIn,, r1) = oracle.price(a.tokenIn);
        (a.pxOut,, r2) = oracle.price(a.tokenOut);
        if (r1 != PriceReason.OK || r2 != PriceReason.OK) {
            ++skipped;
            return;
        }
        a.decIn = t.decimalsOf(a.tokenIn);
        a.decOut = t.decimalsOf(a.tokenOut);
        try account.capValues() returns (uint256 c, uint256, uint256) {
            a.capped = c;
        } catch {
            ++skipped;
            return;
        }
        // Half the trades are small, so runs reach the 20-trade window before the turnover cap.
        uint256 v = a.capped * bound(sizeBps, 1, seed % 2 == 0 ? 100 : 1_500) / 10_000;
        a.amountIn = v * (10 ** (uint256(a.decIn) + 12)) / a.pxIn;
        if (a.amountIn == 0) return;
        // The value as the Executor computes it.
        a.value = a.amountIn * a.pxIn / (10 ** (uint256(a.decIn) + 12));
        a.floor = executor.floorFor(a.amountIn, a.pxIn, a.decIn, a.pxOut, a.decOut, 50);
        if (a.floor == 0) return;
        // The floor three times in four; one unit under it otherwise, which must be refused.
        a.minOut = slip % 4 == 0 && a.floor > 1 ? a.floor - 1 : a.floor;
        // A misbehaving venue about one call in eight, and the venue itself one call in four.
        venue.setBehaviour(MockRouteAdapter.Behaviour(behaviour % 64 < 8 ? behaviour % 10 : 0), "");
        venue.setOutputBps(9_950 + seed % 100);
        a.from = sender % 5 == 0 ? owner : sender % 7 == 0 ? stranger : session;
        a.inBefore = IERC20(a.tokenIn).balanceOf(address(account));
        a.outBefore = IERC20(a.tokenOut).balanceOf(address(account));
        SwapIntentV3 memory i = t.makeIntent(a.tokenIn, a.tokenOut, a.amountIn, a.minOut);
        if (behaviour % 4 == 0) i.adapterId = keccak256("mock venue");
        vm.prank(a.from);
        try executor.swap(i) returns (uint256) {
            _record(a);
        } catch {
            ++refused;
        }
        venue.setBehaviour(MockRouteAdapter.Behaviour.Honest, "");
    }

    function _record(Attempt memory a) internal {
        uint256 inAfter = IERC20(a.tokenIn).balanceOf(address(account));
        uint256 outAfter = IERC20(a.tokenOut).balanceOf(address(account));
        if (a.from != session) _fail("a trade from someone other than the session key");
        if (a.inBefore - inAfter > a.amountIn) _fail("more than amountIn left the account");
        if (a.inBefore - inAfter == 0) _fail("nothing left the account for a trade");
        if (outAfter - a.outBefore < a.minOut) _fail("less than minAmountOut arrived");
        if (a.value * 10_000 > a.capped * 1_000) _fail("a trade above 10% of value");
        if (a.minOut < a.floor) _fail("a minimum below the oracle floor");
        _checkPost(a);
        _checkWindow(a.value, a.capped);
        expected[a.tokenIn] += int256(inAfter) - int256(a.inBefore);
        expected[a.tokenOut] += int256(outAfter) - int256(a.outBefore);
        done.push(Done(block.timestamp, a.value));
        ++trades;
    }

    function _checkPost(Attempt memory a) internal {
        if (a.tokenOut == usdc) return;
        (uint256 capped,,) = account.capValues();
        uint256 held = account.freeBalance(a.tokenOut) * a.pxOut / (10 ** (uint256(a.decOut) + 12));
        if (held * 10_000 > capped * 4_000) _fail("over 40% in one token after a buy");
        if (account.freeBalance(usdc) * 10_000 < account.navUsdc() * 1_000) _fail("under the USDC floor after a buy");
    }

    function _checkWindow(uint256 value, uint256 capped) internal {
        uint256 count;
        uint256 turnover = value;
        for (uint256 k = 0; k < done.length; ++k) {
            if (done[k].at + 86_400 > block.timestamp) {
                ++count;
                turnover += done[k].value;
            }
        }
        if (count >= 20) _fail("a 21st trade in 24 hours");
        if (turnover > capped) _fail("turnover above 100% of value");
    }

    /// Time passes, MON moves up to 5% (pools and the composite feed follow), feeds are refreshed.
    function wait(uint256 secs, uint256 move) external {
        vm.warp(block.timestamp + bound(secs, 0, 2 hours));
        monAnswer = monAnswer * int256(bound(move, 9_500, 10_500)) / 10_000;
        if (monAnswer < 1e7) monAnswer = 1e7;
        t.moveMon(monAnswer);
        if (block.timestamp + 1 hours > executor.sessionOf(agent).validUntil) {
            vm.prank(owner);
            try executor.registerSession(agent, session, uint64(block.timestamp + 7 days)) {} catch {}
        }
    }

    /// The owner deposits USDC or WMON, or withdraws a share of one.
    function flow(uint256 usdcIn, uint256 wmonIn, uint256 withdrawBps) external {
        usdcIn = bound(usdcIn, 0, 500e6);
        wmonIn = bound(wmonIn, 0, 100e18);
        for (uint256 k = 0; k < 2; ++k) {
            address tok = toks[k];
            uint256 before = IERC20(tok).balanceOf(address(account));
            uint256 amount = k == 0 ? usdcIn : wmonIn;
            if (amount != 0) {
                try t.ownerDeposit(tok, amount) {} catch {}
            } else if (withdrawBps % 3 == 0 && before != 0) {
                uint256 share = before * bound(withdrawBps, 1, 5_000) / 10_000;
                vm.prank(owner);
                try account.withdraw(tok, share, owner) {} catch {}
            }
            expected[tok] += int256(IERC20(tok).balanceOf(address(account))) - int256(before);
        }
    }

    /// The sentinel tightens, the guardian pauses, the owner lifts it.
    function mode(uint8 which) external {
        if (which % 4 == 0) {
            vm.prank(sentinel);
            try account.setReduceOnly() {} catch {}
        } else if (which % 4 == 1) {
            vm.prank(guardian);
            try account.pause() {} catch {}
        } else {
            vm.prank(owner);
            try account.unpause() {} catch {}
        }
    }

    /// The agent changes hands and comes back, or its configuration changes; the owner re-arms.
    function transfer(uint8 which) external {
        if (which % 3 == 0) {
            nft.setOwner(agent, stranger);
            nft.setOwner(agent, owner);
        } else if (which % 3 == 1) {
            vm.prank(owner);
            executor.bumpConfigEpoch(agent);
        }
        vm.prank(owner);
        try executor.registerSession(agent, session, uint64(block.timestamp + 7 days)) {} catch {}
    }
}

contract ExecutorV3InvariantTest is ExecutorV3Base {
    ExecutorV3Handler internal handler;
    int256 internal currentMon = 2e8;

    function setUp() public override {
        super.setUp();
        // All four class F tokens held: 700 USDC, 150 WMON (300), 10 A (60), 1 B (40).
        deposit(address(tokA), 10e18);
        deposit(address(tokB), 1e8);
        handler = new ExecutorV3Handler(
            this,
            executor,
            account,
            venue,
            nft,
            [address(usdc), address(wmon), address(tokA), address(tokB)],
            sentinel,
            guardian
        );
        targetContract(address(handler));
    }

    // ----- for the handler -----

    function makeIntent(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        returns (SwapIntentV3 memory)
    {
        return intent(tokenIn, tokenOut, amountIn, minOut);
    }

    function decimalsOf(address token) external view returns (uint8) {
        return dec(token);
    }

    function ownerDeposit(address token, uint256 amount) external {
        deposit(token, amount);
    }

    /// MON moves: its feed, the USDC/WMON and A/WMON pools, the venue, and B's
    /// rate leg so B stays at 40 USDC; every other feed is refreshed.
    function moveMon(int256 answer) external {
        currentMon = answer;
        setMon(answer);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 p = uint256(answer) * 1e10;
        (address a0,) = _sorted(address(tokA), address(wmon));
        if (a0 == address(tokA)) priceV3(poolAWmon, 6e18, p);
        else priceV3(poolAWmon, p, 6e18);
        usdcUsd.push(1e8);
        aUsd.push(6e8);
        // forge-lint: disable-next-line(unsafe-typecast)
        bRate.push(int256(40e18 * 1e18 / p));
    }

    // ----- invariants -----

    function invariant_TheExecutorAndTheRouterKeepNothing() public view {
        assertNothingKept();
    }

    function invariant_TheAccountsBalancesAreExactlyItsFlowsAndTrades() public view {
        address[4] memory all = [address(usdc), address(wmon), address(tokA), address(tokB)];
        for (uint256 k = 0; k < 4; ++k) {
            assertEq(int256(IERC20(all[k]).balanceOf(address(account))), handler.expected(all[k]));
        }
    }

    function invariant_NoLimitWasBroken() public view {
        assertFalse(handler.violated(), handler.violation());
    }

    function invariant_TheWindowNeverExceedsTwenty() public view {
        (, uint256 left,,) = executor.limits(address(account));
        assertLe(left, 20);
    }
}
