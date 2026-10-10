// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {StdStorage, stdStorage} from "forge-std/Test.sol";
import {ExecutorV3} from "../../src/fund/ExecutorV3.sol";
import {IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {PolicyV3, SwapIntentV3} from "../../src/interfaces/IExecutorV3.sol";
import {ITokenRegistry} from "../../src/interfaces/IFund.sol";
import {PoolKey} from "../../src/interfaces/IUniswap.sol";
import {MockToken} from "../mocks/CustodyMocks.sol";
import {ExecutorV3Base} from "./ExecutorV3Base.sol";

/// The Executor with a way to write its ring buffer, so a case can start with
/// past trades. Every check is the real Executor's.
contract ExecutorV3Harness is ExecutorV3 {
    constructor(
        address admin,
        address guardian_,
        IAgentNFTView nft,
        ITokenRegistry tokens,
        address usdc,
        address wmon,
        PolicyV3 memory p
    ) ExecutorV3(admin, guardian_, nft, tokens, usdc, wmon, p) {}

    function seedTrade(address account, uint256 slot, uint64 at, uint192 value) external {
        _rings[account].trades[slot] = PastTrade(at, value);
    }

    function clearRing(address account) external {
        delete _rings[account];
    }
}

/// packages/policy's executorV3.verdict wrote down what it answers for each
/// case (packages/policy/fixtures/executor-v3-parity.json); this replays every
/// case on the real Executor, account, registries and oracle, and requires the
/// same answer. packages/policy's test fails if the fixture is not what its code
/// answers now, so a change to either side alone fails one of them.
contract ExecutorV3ParityTest is ExecutorV3Base {
    using stdStorage for StdStorage;

    struct ExecutorCase {
        string name;
        uint256 usdc;
        uint256 wmon;
        uint256 a;
        uint256 b;
        string[] setupTokens;
        uint256[] setupAmounts;
        uint256 peakMon;
        uint256 mon;
        uint256 monFeedAge;
        uint256 aFeedAge;
        uint256 poolBps;
        uint256 mode;
        bool paused;
        bool adapterAllowed;
        bool optedIn;
        bool attestorSet;
        uint256 aStatus;
        uint256 wmonCap;
        uint256[] tradeAges;
        uint256[] tradeValues;
        string tokenIn;
        string tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 deadline;
        uint256 attestIn;
        uint256 attestOut;
        uint256 attestInBps;
        uint256 attestOutBps;
        uint256 routeKind;
        uint256 amountOut;
        uint256 reason;
        uint256 navAfter;
        uint256 drawdownBps;
        bool valuesUsable;
    }

    string internal constant CASE_TYPE =
        "ExecutorCase(string name,uint256 usdc,uint256 wmon,uint256 a,uint256 b,string[] setupTokens,uint256[] setupAmounts,uint256 peakMon,uint256 mon,uint256 monFeedAge,uint256 aFeedAge,uint256 poolBps,uint256 mode,bool paused,bool adapterAllowed,bool optedIn,bool attestorSet,uint256 aStatus,uint256 wmonCap,uint256[] tradeAges,uint256[] tradeValues,string tokenIn,string tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 deadline,uint256 attestIn,uint256 attestOut,uint256 attestInBps,uint256 attestOutBps,uint256 routeKind,uint256 amountOut,uint256 reason,uint256 navAfter,uint256 drawdownBps,bool valuesUsable)";

    string internal json;
    /// A token off the registry.
    MockToken internal x;

    function newExecutor(PolicyV3 memory p) internal override returns (ExecutorV3) {
        return new ExecutorV3Harness(
            admin,
            guardian,
            IAgentNFTView(address(nft)),
            ITokenRegistry(address(tokens)),
            address(usdc),
            address(wmon),
            p
        );
    }

    function setUp() public override {
        fundOnBuild = false;
        super.setUp();
        setAttestor();
        x = new MockToken("X", 18);
        json = vm.readFile("../../packages/policy/fixtures/executor-v3-parity.json");
    }

    function test_TheFixtureUsesTheLaunchPolicyAndTheBasesClock() public view {
        assertEq(vm.parseJsonBytes32(json, ".policyHash"), executor.policyHash());
        assertEq(vm.parseJsonUint(json, ".t0"), block.timestamp);
    }

    /// Every case, in four slices: one test's gas stays under forge's limit (L-179).
    function test_TheExecutorMatchesThePolicyPackage_Slice0() public {
        _replaySlice(0, 60);
    }

    function test_TheExecutorMatchesThePolicyPackage_Slice1() public {
        _replaySlice(60, 120);
    }

    function test_TheExecutorMatchesThePolicyPackage_Slice2() public {
        _replaySlice(120, 180);
    }

    function test_TheExecutorMatchesThePolicyPackage_Slice3() public {
        _replaySlice(180, type(uint256).max);
    }

    /// Replays the cases in `[from, to)`; PARITY_FROM and PARITY_TO (inclusive) narrow it further, for a trace.
    function _replaySlice(uint256 from, uint256 to) internal {
        ExecutorCase[] memory cases = abi.decode(vm.parseJsonTypeArray(json, ".cases", CASE_TYPE), (ExecutorCase[]));
        assertEq(cases.length, vm.parseJsonUint(json, ".caseCount"));
        uint256 only0 = vm.envOr("PARITY_FROM", uint256(0));
        uint256 only1 = vm.envOr("PARITY_TO", type(uint256).max);
        uint256 start = vm.snapshotState();
        for (uint256 k = from; k < cases.length && k < to; ++k) {
            if (k < only0 || k > only1) continue;
            _replay(cases[k]);
            vm.revertToState(start);
        }
    }

    /// MON moves: its feed, the USDC/WMON, A/WMON and MON/C pools, the venue,
    /// and B's rate leg so B stays at 40 USDC; every other feed is refreshed.
    function moveMon(int256 answer) internal {
        setMon(answer);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 p = uint256(answer) * 1e10;
        (address a0,) = _sorted(address(tokA), address(wmon));
        if (a0 == address(tokA)) priceV3(poolAWmon, 6e18, p);
        else priceV3(poolAWmon, p, 6e18);
        PoolKey memory monC = PoolKey(address(0), address(tokC), 500, 10, address(0));
        manager.setPrice(monC, p, PX_C);
        stateView.setSqrt(idMonC, _sqrtX96(p, PX_C));
        usdcUsd.push(1e8);
        aUsd.push(6e8);
        // forge-lint: disable-next-line(unsafe-typecast)
        bRate.push(int256(40e18 * 1e18 / p));
    }

    function _replay(ExecutorCase memory c) internal {
        emit log_named_string("case", c.name);
        // The account at the peak: deposits, class A positions through the honest venue, a poke.
        // forge-lint: disable-next-line(unsafe-typecast)
        moveMon(int256(c.peakMon));
        if (c.usdc > 0) deposit(address(usdc), c.usdc);
        if (c.wmon > 0) deposit(address(wmon), c.wmon);
        if (c.a > 0) deposit(address(tokA), c.a);
        if (c.b > 0) deposit(address(tokB), c.b);
        bool screenedSetup;
        for (uint256 k = 0; k < c.setupTokens.length; ++k) {
            if (_isScreened(_token(c.setupTokens[k]))) screenedSetup = true;
        }
        if (c.optedIn || screenedSetup) optIn();
        for (uint256 k = 0; k < c.setupTokens.length; ++k) {
            SwapIntentV3 memory b = trade(address(usdc), _token(c.setupTokens[k]), c.setupAmounts[k]);
            b.adapterId = VENUE;
            submit(b);
        }
        account.poke();
        ExecutorV3Harness(address(executor)).clearRing(address(account));

        // Then the market the case describes.
        // forge-lint: disable-next-line(unsafe-typecast)
        moveMon(int256(c.mon));
        // forge-lint: disable-next-line(unsafe-typecast)
        monUsd.setRound(77, int256(c.mon), block.timestamp - c.monFeedAge, 77);
        aUsd.setRound(77, 6e8, block.timestamp - c.aFeedAge, 77);
        uint256 spot = c.mon * 1e10 * c.poolBps / 10_000 / 1e12;
        (address u0,) = _sorted(address(usdc), address(wmon));
        if (u0 == address(wmon)) setSpot(poolUsdcWmon, spot, 1e18);
        else setSpot(poolUsdcWmon, 1e18, spot);
        if (c.mode == 1) {
            vm.prank(sentinel);
            account.setReduceOnly();
        } else if (c.mode == 2) {
            vm.prank(sentinel);
            account.pause();
        }
        if (c.paused) {
            vm.prank(guardian);
            executor.pauseAll();
        }
        if (!c.adapterAllowed) {
            vm.prank(guardian);
            pools.pauseAdapter(VENUE);
        }
        if (c.aStatus == 2) {
            vm.prank(SCREENER);
            tokens.setSellOnly(address(tokA));
        } else if (c.aStatus == 3) {
            vm.prank(SCREENER);
            tokens.freeze(address(tokA));
        }
        if (c.wmonCap < 4_500) {
            vm.prank(SCREENER);
            // forge-lint: disable-next-line(unsafe-typecast)
            tokens.lowerCap(address(wmon), uint16(c.wmonCap));
        }
        vm.prank(owner);
        account.setScreenedOptIn(c.optedIn);
        if (!c.attestorSet) stdstore.target(address(tokens)).sig("verifier()").checked_write(address(0));
        for (uint256 j = 0; j < c.tradeAges.length; ++j) {
            // forge-lint: disable-next-line(unsafe-typecast)
            ExecutorV3Harness(address(executor))
                .seedTrade(address(account), j, uint64(block.timestamp - c.tradeAges[j]), uint192(c.tradeValues[j]));
        }
        venue.setFixedOut(c.amountOut);

        address tin = _token(c.tokenIn);
        address tout = _token(c.tokenOut);
        SwapIntentV3 memory i = intentWith(tin, tout, c.amountIn, c.minAmountOut, _routeOf(c.routeKind, tin, tout));
        i.adapterId = VENUE;
        // forge-lint: disable-next-line(unsafe-typecast)
        i.deadline = uint64(c.deadline);
        i.attestationIn = _attestation(tin, c.attestIn, c.attestInBps);
        i.attestationOut = _attestation(tout, c.attestOut, c.attestOutBps);
        (,,, uint256 drawdown) = _drawdown();
        vm.prank(session);
        try executor.swap(i) returns (uint256 out) {
            assertEq(c.reason, 255, string.concat(c.name, ": the policy package refused it"));
            assertEq(out, c.amountOut, string.concat(c.name, ": amount out"));
            assertEq(account.navUsdc(), c.navAfter, string.concat(c.name, ": NAV after"));
        } catch (bytes memory why) {
            assertEq(bytes4(why), ExecutorV3.Rejected.selector, string.concat(c.name, ": not a Rejected"));
            uint256 r;
            assembly ("memory-safe") {
                r := mload(add(why, 36))
            }
            assertEq(r, c.reason, string.concat(c.name, ": reason"));
        }
        if (c.valuesUsable) assertEq(drawdown, c.drawdownBps, string.concat(c.name, ": drawdown"));
        else assertEq(drawdown, type(uint256).max, string.concat(c.name, ": the account's values were readable"));
    }

    function _token(string memory name) internal view returns (address) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256("USDC")) return address(usdc);
        if (h == keccak256("WMON")) return address(wmon);
        if (h == keccak256("A")) return address(tokA);
        if (h == keccak256("B")) return address(tokB);
        if (h == keccak256("C")) return address(tokC);
        if (h == keccak256("D")) return address(tokD);
        if (h == keccak256("E")) return address(tokE);
        if (h == keccak256("F")) return address(tokF);
        return address(x);
    }

    function _isScreened(address token) internal view returns (bool) {
        return token == address(tokD) || token == address(tokE) || token == address(tokF);
    }

    /// The route by kind: natural, to the wrong token (the first of WMON, A, B that is neither side), four hops, none.
    function _routeOf(uint256 kind, address tin, address tout) internal view returns (bytes32[] memory) {
        if (kind == 0) return routeFor(tin, tout);
        if (kind == 1) {
            address[3] memory others = [address(wmon), address(tokA), address(tokB)];
            for (uint256 k = 0; k < 3; ++k) {
                if (others[k] != tin && others[k] != tout) return routeFor(tin, others[k]);
            }
        }
        if (kind == 2) {
            bytes32[] memory four = new bytes32[](4);
            for (uint256 k = 0; k < 4; ++k) {
                four[k] = idUsdcWmon;
            }
            return four;
        }
        return new bytes32[](0);
    }

    /// An attestation for a class A side: none, fresh at the reference times `bps`, or expired.
    function _attestation(address token, uint256 kind, uint256 bps) internal returns (bytes memory) {
        if (kind == 0 || token == address(x) || !isClassA(token)) return "";
        uint256 price = refPrice[token] * bps / 10_000;
        if (kind == 1) return attestation(token, price);
        attestor.set(token, price, uint64(block.timestamp - 1));
        return abi.encode(token);
    }

    /// The account's drawdown when its prices are usable, or max when they are not.
    function _drawdown() internal view returns (uint256 nav, uint256 perUnit, uint256 peak, uint256 drawdown) {
        try account.breakerState() returns (uint256 n, uint256 p, uint256 pk, uint256 d) {
            return (n, p, pk, d);
        } catch {
            return (0, 0, 0, type(uint256).max);
        }
    }
}
