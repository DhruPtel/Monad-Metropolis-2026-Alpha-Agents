// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";
import {OracleReason} from "../../src/interfaces/IOracle.sol";
import {MockFeed} from "../mocks/OracleMocks.sol";
import {BreakerBase} from "../custody/BreakerBase.sol";
import {OracleBase} from "./OracleBase.sol";

/// The shared parity fixture (P2-U3): packages/policy wrote down what its
/// offchain checks answer for each case; these tests make the contracts
/// answer the same cases. packages/policy's parity test fails if the fixture
/// is not what its code builds now, so a change to either side alone fails.
library ParityFixture {
    string internal constant PATH = "../../packages/policy/fixtures/oracle-breaker-parity.json";
}

contract OracleParityTest is OracleBase {
    struct FeedCase {
        string name;
        string feed;
        bool reverts;
        uint256 decimals;
        uint256 roundId;
        int256 answer;
        uint256 updatedAt;
        uint256 answeredInRound;
        uint256 time;
        uint256 reason;
        uint256 priceE18;
        uint256 updatedAtOut;
    }

    struct PoolCase {
        string name;
        uint256 oracleAnswer;
        bool poolReverts;
        uint256 sqrtPriceX96;
        uint256 poolReason;
        uint256 poolPriceE18;
        uint256 deviationReason;
        uint256 deviationBps;
    }

    struct PegCase {
        string name;
        uint256 answer;
        uint256 updatedAt;
        uint256 time;
        uint256 reason;
    }

    string internal json;

    function setUp() public override {
        super.setUp();
        json = vm.readFile(ParityFixture.PATH);
    }

    function test_TheFixtureUsesTheContractsLimits() public view {
        assertEq(vm.parseJsonUint(json, ".limits.monUsdMaxAge"), adapter.MON_USD_MAX_AGE());
        assertEq(vm.parseJsonUint(json, ".limits.usdcUsdMaxAge"), adapter.USDC_USD_MAX_AGE());
        assertEq(vm.parseJsonUint(json, ".limits.maxDeviationBps"), adapter.MAX_DEVIATION_BPS());
        assertEq(vm.parseJsonUint(json, ".limits.maxDepegBps"), adapter.MAX_DEPEG_BPS());
    }

    function test_FeedsMatchThePolicyPackage() public {
        FeedCase[] memory cases = abi.decode(
            vm.parseJsonTypeArray(
                json,
                ".feedCases",
                "FeedCase(string name,string feed,bool reverts,uint256 decimals,uint256 roundId,int256 answer,uint256 updatedAt,uint256 answeredInRound,uint256 time,uint256 reason,uint256 priceE18,uint256 updatedAtOut)"
            ),
            (FeedCase[])
        );
        assertEq(cases.length, vm.parseJsonUint(json, ".feedCaseCount"));
        // The same reading code with USDC/USD's bound, for the USDC/USD cases.
        OracleAdapter.Config memory c = config();
        c.monUsdMaxAge = USDC_MAX_AGE;
        OracleAdapter usdcBound = new OracleAdapter(c);
        for (uint256 i = 0; i < cases.length; ++i) {
            FeedCase memory f = cases[i];
            monFeed.setFailure(f.reverts ? MockFeed.Failure.RevertRound : MockFeed.Failure.None);
            // forge-lint: disable-next-line(unsafe-typecast)
            monFeed.setDecimals(uint8(f.decimals));
            // forge-lint: disable-next-line(unsafe-typecast)
            monFeed.setRound(uint80(f.roundId), f.answer, f.updatedAt, uint80(f.answeredInRound));
            vm.warp(f.time);
            OracleAdapter a = keccak256(bytes(f.feed)) == keccak256("USDC_USD") ? usdcBound : adapter;
            (uint256 p, uint256 at, OracleReason r) = a.price(wmonToken);
            assertEq(uint256(r), f.reason, string.concat(f.name, ": reason"));
            assertEq(p, f.priceE18, string.concat(f.name, ": price"));
            assertEq(at, f.updatedAtOut, string.concat(f.name, ": updatedAt"));
        }
    }

    function test_PoolsMatchThePolicyPackage() public {
        PoolCase[] memory cases = abi.decode(
            vm.parseJsonTypeArray(
                json,
                ".poolCases",
                "PoolCase(string name,uint256 oracleAnswer,bool poolReverts,uint256 sqrtPriceX96,uint256 poolReason,uint256 poolPriceE18,uint256 deviationReason,uint256 deviationBps)"
            ),
            (PoolCase[])
        );
        assertEq(cases.length, vm.parseJsonUint(json, ".poolCaseCount"));
        uint256 t0 = vm.parseJsonUint(json, ".limits.t0");
        vm.warp(t0);
        for (uint256 i = 0; i < cases.length; ++i) {
            PoolCase memory c = cases[i];
            monFeed.setRound(7, int256(c.oracleAnswer), t0, 7);
            stateView.setReverts(c.poolReverts);
            // forge-lint: disable-next-line(unsafe-typecast)
            stateView.setSqrtPrice(uint160(c.sqrtPriceX96));
            (uint256 p, OracleReason pr) = adapter.poolPrice(wmonToken);
            assertEq(uint256(pr), c.poolReason, string.concat(c.name, ": pool reason"));
            assertEq(p, c.poolPriceE18, string.concat(c.name, ": pool price"));
            (uint256 bps, OracleReason dr) = adapter.poolDeviationBps(wmonToken);
            assertEq(uint256(dr), c.deviationReason, string.concat(c.name, ": deviation reason"));
            assertEq(bps, c.deviationBps, string.concat(c.name, ": deviation"));
            (bool ok, OracleReason tr) = adapter.tradable(wmonToken);
            assertEq(ok, c.deviationReason == 0, string.concat(c.name, ": tradable"));
            assertEq(uint256(tr), c.deviationReason, string.concat(c.name, ": tradable reason"));
        }
    }

    function test_TheDepegGuardMatchesThePolicyPackage() public {
        PegCase[] memory cases = abi.decode(
            vm.parseJsonTypeArray(
                json, ".pegCases", "PegCase(string name,uint256 answer,uint256 updatedAt,uint256 time,uint256 reason)"
            ),
            (PegCase[])
        );
        assertEq(cases.length, vm.parseJsonUint(json, ".pegCaseCount"));
        for (uint256 i = 0; i < cases.length; ++i) {
            PegCase memory c = cases[i];
            usdcFeed.setRound(7, int256(c.answer), c.updatedAt, 7);
            vm.warp(c.time);
            (,, OracleReason r) = adapter.usdcPeg();
            assertEq(uint256(r), c.reason, string.concat(c.name, ": reason"));
        }
    }
}

contract BreakerParityTest is BreakerBase {
    struct Step {
        string op;
        string token;
        uint256 amount;
        uint256 answer;
        uint256 warp;
        uint256 units;
        uint256 usdc;
        uint256 wmon;
        uint256 mode;
        uint256 peak;
        uint256 lastWmonPriceE18;
        uint256 nav;
        uint256 perUnit;
        uint256 pokePeak;
    }

    string internal constant STEP_TYPE =
        "Step(string op,string token,uint256 amount,uint256 answer,uint256 warp,uint256 units,uint256 usdc,uint256 wmon,uint256 mode,uint256 peak,uint256 lastWmonPriceE18,uint256 nav,uint256 perUnit,uint256 pokePeak)";

    string internal json;

    function setUp() public override {
        super.setUp();
        json = vm.readFile(ParityFixture.PATH);
    }

    function test_TheFixtureUsesTheContractsBreaker() public view {
        assertEq(vm.parseJsonUint(json, ".limits.breakerReduceOnlyBps"), account.BREAKER_REDUCE_ONLY_BPS());
        assertEq(vm.parseJsonUint(json, ".limits.breakerPauseBps"), account.BREAKER_PAUSE_BPS());
        assertEq(vm.parseJsonUint(json, ".limits.peakDays"), account.PEAK_DAYS());
    }

    /// Replays every sequence on a fresh account from the fixture's start time.
    function test_TheBreakerMatchesThePolicyPackage() public {
        uint256 count = vm.parseJsonUint(json, ".breakerCaseCount");
        uint256 t0 = vm.parseJsonUint(json, ".limits.t0");
        vm.warp(t0);
        setMon(ONE_DOLLAR);
        uint256 start = vm.snapshotState();
        for (uint256 i = 0; i < count; ++i) {
            string memory key = string.concat(".breakerCases[", vm.toString(i), "]");
            string memory name = vm.parseJsonString(json, string.concat(key, ".name"));
            Step[] memory steps =
                abi.decode(vm.parseJsonTypeArray(json, string.concat(key, ".steps"), STEP_TYPE), (Step[]));
            assertEq(steps.length, vm.parseJsonUint(json, string.concat(key, ".stepCount")));
            for (uint256 j = 0; j < steps.length; ++j) {
                _apply(steps[j]);
                _check(steps[j], string.concat(name, " step ", vm.toString(j), " (", steps[j].op, ")"));
            }
            vm.revertToState(start);
        }
    }

    function _is(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _apply(Step memory s) private {
        if (_is(s.op, "price")) {
            vm.warp(block.timestamp + s.warp);
            monFeed.setFailure(MockFeed.Failure.None);
            setMon(int256(s.answer));
        } else if (_is(s.op, "deposit")) {
            deposit(_is(s.token, "USDC") ? usdc : wmon, s.amount);
        } else if (_is(s.op, "withdraw")) {
            withdraw(_is(s.token, "USDC") ? address(usdc) : address(wmon), s.amount);
        } else if (_is(s.op, "withdrawAll")) {
            vm.prank(owner);
            account.withdrawAll(owner);
        } else if (_is(s.op, "poke")) {
            (uint256 nav, uint256 p, uint256 peak) = account.poke();
            assertEq(nav, s.nav, "poke nav");
            assertEq(p, s.perUnit, "poke per unit");
            assertEq(peak, s.pokePeak, "poke peak");
        } else if (_is(s.op, "unpause")) {
            vm.prank(owner);
            account.unpause();
        } else if (_is(s.op, "monDown")) {
            monFeed.setFailure(MockFeed.Failure.RevertRound);
        } else if (_is(s.op, "monUp")) {
            monFeed.setFailure(MockFeed.Failure.None);
        } else {
            revert(string.concat("unknown op ", s.op));
        }
    }

    function _check(Step memory s, string memory where) private view {
        assertEq(account.units(), s.units, string.concat(where, ": units"));
        assertEq(usdcBal(address(account)), s.usdc, string.concat(where, ": USDC"));
        assertEq(wmonBal(address(account)), s.wmon, string.concat(where, ": WMON"));
        assertEq(uint256(account.mode()), s.mode, string.concat(where, ": mode"));
        assertEq(account.peakPerUnit7d(), s.peak, string.concat(where, ": peak"));
        assertEq(account.lastWmonPriceE18(), s.lastWmonPriceE18, string.concat(where, ": last price"));
    }
}
